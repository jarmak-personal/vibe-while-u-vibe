import { Player } from "./player.js";
import { getCachedTracks } from "./cache.js";
import {
  type MusicGenerator,
  QuotaExceededError,
  GeneratorUnavailableError,
} from "./generators/types.js";
import {
  MOOD_DEFINITIONS,
  MOOD_TRANSITIONS,
  buildLocalMusicPrompt,
  buildMusicPrompt,
  type Mood,
} from "./moods.js";
import { updateState } from "./state.js";

export interface PlaylistOptions {
  volume: number;
  excludedGenres: string[];
  interestingVibes: boolean;
  vocals: boolean;
  genreHint: string | null;
  cacheSizePerMood: number;
  cacheOnlyMode: boolean;
  generator: MusicGenerator;
}

interface PendingMoodState {
  mood: Mood;
  lyrics: string | null;
  // Filled in by preparePending() once cache lookup or generation resolves.
  // Holds every cached track for the mood (pre-shuffled) so promotion picks
  // up the full rotation, not just the first entry.
  paths: string[] | null;
  preparing: boolean;
}

export class Playlist {
  // Minimum time a mood must stay in place before a new one can cut it.
  // Protects against thrash when a session's activity oscillates between
  // moods — the new mood is still pre-generated in the background, but the
  // cut-over waits for this window to elapse (or for the current track to
  // finish naturally, whichever comes first).
  private static readonly MIN_MOOD_LIFETIME_MS = 60_000;

  private player: Player;
  private generator: MusicGenerator;
  private currentMood: Mood | null = null;
  private pendingMood: PendingMoodState | null = null;
  private trackQueue: string[] = [];
  private trackIndex = 0;
  private opts: PlaylistOptions;
  private currentLyrics: string | null = null;
  private volume: number;
  private sessionExcludedGenres: string[] = [];
  private excludedGenresOnce: string[] = [];
  private genreHintOnce: string | null = null;
  // Timestamp when the current mood (not track) started playing. Loops of
  // the same mood don't reset this — the clock measures mood stability, not
  // audio freshness.
  private moodStartedAt = 0;
  private promoteTimer: NodeJS.Timeout | null = null;
  // Serializes all generator requests — exactly one in flight.
  private genLock: Promise<void> = Promise.resolve();
  private genBusy = false;
  // Sticky once the API reports quota exhaustion — suppresses further
  // generation (cached tracks still play) until the daemon restarts.
  private quotaExceeded = false;
  // Sticky when the generator itself is unavailable (e.g. missing API key,
  // local worker failed to start). Same semantics as quotaExceeded: cached
  // tracks still play, but no new generation is attempted.
  private generatorUnavailable = false;

  constructor(opts: PlaylistOptions) {
    this.opts = opts;
    this.generator = opts.generator;
    this.volume = opts.volume;
    this.player = new Player(opts.volume);
    this.player.onEnd(() => this.onTrackFinished());
  }

  /** Returns a user-visible error if no audio backend is available. */
  getBackendError(): string | null {
    return this.player.getBackendError();
  }

  private buildPrompt(mood: Mood, vocals: boolean): string {
    if (this.generator.promptStyle === "musicgen") {
      return buildLocalMusicPrompt(
        mood,
        this.effectiveExcludedGenres(),
        this.opts.interestingVibes,
        this.effectiveGenreHint()
      );
    }
    return buildMusicPrompt(
      mood,
      this.effectiveExcludedGenres(),
      this.opts.interestingVibes,
      vocals,
      this.effectiveGenreHint()
    );
  }

  private async withGenLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.genLock;
    let release!: () => void;
    this.genLock = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    this.genBusy = true;
    try {
      return await fn();
    } finally {
      this.genBusy = false;
      release();
    }
  }

  /**
   * Request a mood change.
   *
   * - `immediate=true` — cut the current track and apply now. Used by
   *   explicit user commands (e.g. /vibe setMood). Blocks on generation.
   * - Otherwise — pre-generate the new mood in the background. Promote when
   *   (a) MIN_MOOD_LIFETIME_MS has elapsed AND the track is ready, or
   *   (b) the current track finishes naturally and the track is ready.
   *   While waiting, the current track keeps looping — silence is never a vibe.
   */
  async switchMood(mood: Mood, lyrics: string | null, immediate = false): Promise<void> {
    if (immediate) {
      this.clearPromoteTimer();
      if (this.pendingMood) {
        this.pendingMood = null;
        updateState({ pendingMood: null });
      }
      await this.applyMood(mood, lyrics);
      return;
    }

    if (mood === this.currentMood && !this.pendingMood) return;
    // Already queued for this mood — nothing to do. (We intentionally don't
    // update lyrics on an in-flight pending: doing so would either race the
    // generator or force-restart it, and the mood itself is what matters.)
    if (this.pendingMood?.mood === mood) return;

    // First track of the session — no running mood to protect, apply directly.
    if (!this.player.isPlaying() && this.currentMood === null) {
      await this.applyMood(mood, lyrics);
      return;
    }

    this.pendingMood = { mood, lyrics, paths: null, preparing: false };
    updateState({ pendingMood: mood });
    this.preparePending().catch(() => {});
    this.schedulePromoteCheck();
  }

  /**
   * Force-skip the current track. If a pending mood is ready, promote it.
   * Otherwise advance the queue (which for a single-track queue means loop).
   */
  skip(): void {
    if (this.pendingMood?.paths) {
      this.promoteNow();
      return;
    }
    this.player.stop();
    if (this.trackQueue.length > 0) {
      this.playNext();
    }
  }

  private onTrackFinished(): void {
    if (this.pendingMood?.paths) {
      // Pre-gen landed — promote now. Natural track boundary, no thrash.
      this.promoteNow();
      return;
    }
    // Still waiting on generation (or no pending) — loop the current track.
    this.playNext();
  }

  private schedulePromoteCheck(): void {
    this.clearPromoteTimer();
    const elapsed = Date.now() - this.moodStartedAt;
    const waitMs = Playlist.MIN_MOOD_LIFETIME_MS - elapsed;
    if (waitMs <= 0) {
      this.tryPromote();
      return;
    }
    this.promoteTimer = setTimeout(() => {
      this.promoteTimer = null;
      this.tryPromote();
    }, waitMs);
  }

  private clearPromoteTimer(): void {
    if (this.promoteTimer) {
      clearTimeout(this.promoteTimer);
      this.promoteTimer = null;
    }
  }

  private tryPromote(): void {
    const pending = this.pendingMood;
    if (!pending?.paths) return;
    if (this.player.isPlaying()) {
      const elapsed = Date.now() - this.moodStartedAt;
      if (elapsed < Playlist.MIN_MOOD_LIFETIME_MS) {
        this.schedulePromoteCheck();
        return;
      }
    }
    this.promoteNow();
  }

  private promoteNow(): void {
    const pending = this.pendingMood;
    if (!pending?.paths || pending.paths.length === 0) return;

    this.clearPromoteTimer();
    this.pendingMood = null;

    this.currentMood = pending.mood;
    this.currentLyrics = pending.lyrics;
    this.trackQueue = pending.paths;
    this.trackIndex = 0;

    const def = MOOD_DEFINITIONS[pending.mood];
    updateState({
      currentMood: pending.mood,
      trackLabel: def.label,
      pendingMood: null,
    });

    this.playCurrentTrack();
    this.moodStartedAt = Date.now();
    this.prefetchNextMood(pending.mood);
  }

  private async preparePending(): Promise<void> {
    const pending = this.pendingMood;
    if (!pending || pending.preparing || pending.paths) return;
    pending.preparing = true;

    const mood = pending.mood;
    const hasSteering =
      this.genreHintOnce !== null ||
      this.sessionExcludedGenres.length > 0 ||
      this.excludedGenresOnce.length > 0;
    // Vocals mode and any active steering bypass the cache — we always want
    // a fresh generation because session-specific lyrics/steering won't match
    // whatever happens to be sitting on disk. Cache-only mode forces cache
    // usage regardless and skips generation entirely.
    const useCache = this.opts.cacheOnlyMode || (!this.opts.vocals && !hasSteering);

    // Cache-cap rule: once cache is full for this mood, play the rotation
    // instead of generating. Below the cap we still generate new variety so
    // the user isn't stuck on the same 1-2 tracks per mood forever.
    // Cache-only mode: play whatever exists, regardless of cap.
    if (useCache) {
      const cached = getCachedTracks(mood);
      const atCap = cached.length >= this.opts.cacheSizePerMood;
      if (this.opts.cacheOnlyMode || atCap) {
        if (this.pendingMood !== pending) return;
        if (cached.length === 0) {
          // Cache-only with no tracks yet — drop the pending switch and
          // surface a hint. Keep whatever's currently playing.
          this.pendingMood = null;
          updateState({
            pendingMood: null,
            error: `Cache-only mode: no cached tracks for "${mood}" yet. Run once without cache-only to warm up.`,
          });
          return;
        }
        pending.paths = shuffle([...cached]);
        pending.preparing = false;
        this.tryPromote();
        return;
      }
    }

    if (this.opts.cacheOnlyMode) {
      // Belt-and-suspenders: should be unreachable given the branch above.
      if (this.pendingMood === pending) {
        this.pendingMood = null;
        updateState({ pendingMood: null });
      }
      return;
    }

    if (this.quotaExceeded || this.generatorUnavailable) {
      // Nothing cached and no way to generate — drop the pending mood so the
      // status line doesn't claim a cut-over that will never happen.
      if (this.pendingMood === pending) {
        this.pendingMood = null;
        updateState({ pendingMood: null });
      }
      return;
    }

    updateState({ generating: true });
    try {
      const isInstrumental = !this.opts.vocals || mood === "welcome";
      const prompt = this.buildPrompt(mood, !isInstrumental);
      const result = await this.withGenLock(async () => {
        // Re-check cache inside the lock — a parallel prefetch may have
        // filled it up to the cap while we were waiting our turn.
        if (useCache) {
          const fresh = getCachedTracks(mood);
          if (fresh.length >= this.opts.cacheSizePerMood) {
            return { kind: "cache" as const, paths: shuffle([...fresh]) };
          }
        }
        const path = await this.generator.generateTrack({
          mood,
          musicPrompt: prompt,
          lyrics: pending.lyrics,
          instrumental: isInstrumental,
        });
        // Fold any existing cached tracks into the rotation so the user
        // hears variety immediately, not just the new track on repeat.
        // (Only applies to instrumental — vocals mode never reuses cache.)
        const rotation = useCache
          ? [path, ...shuffle(getCachedTracks(mood).filter((p) => p !== path))]
          : [path];
        return { kind: "generated" as const, paths: rotation };
      });

      if (this.pendingMood !== pending) {
        updateState({ generating: false });
        return;
      }

      pending.paths = result.paths;
      pending.preparing = false;
      this.consumeOneShotSteering();
      updateState({ generating: false });
      this.tryPromote();
    } catch (err) {
      const wasStillPending = this.pendingMood === pending;
      if (wasStillPending) {
        this.pendingMood = null;
      }
      if (err instanceof QuotaExceededError) {
        this.quotaExceeded = true;
        updateState({
          generating: false,
          quotaExceeded: true,
          pendingMood: null,
          error: err.message,
        });
      } else if (err instanceof GeneratorUnavailableError) {
        this.generatorUnavailable = true;
        updateState({
          generating: false,
          pendingMood: null,
          error: err.message,
        });
      } else {
        updateState({
          generating: false,
          pendingMood: null,
          error: `Generation failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  /**
   * Apply a mood immediately. Used for the first mood of a session (nothing
   * to protect yet) and for explicit `/vibe setMood immediate=true` commands.
   */
  private async applyMood(mood: Mood, lyrics: string | null): Promise<void> {
    this.currentMood = mood;
    this.currentLyrics = lyrics;
    this.trackIndex = 0;
    const def = MOOD_DEFINITIONS[mood];

    updateState({
      currentMood: mood,
      trackLabel: def.label,
    });

    const hasSteering =
      this.genreHintOnce !== null ||
      this.sessionExcludedGenres.length > 0 ||
      this.excludedGenresOnce.length > 0;
    const useCache = this.opts.cacheOnlyMode || (!this.opts.vocals && !hasSteering);
    const cached = useCache ? getCachedTracks(mood) : [];

    if (this.opts.cacheOnlyMode) {
      // Zero-credit mode: play whatever's cached, regardless of cap. If the
      // cache is empty for this mood, stay silent and surface a message.
      if (cached.length > 0) {
        this.trackQueue = shuffle([...cached]);
        this.playCurrentTrack();
        this.moodStartedAt = Date.now();
      } else {
        updateState({
          generating: false,
          error: `Cache-only mode: no cached tracks for "${mood}" yet. Run once without cache-only to warm up.`,
        });
      }
      // No prefetch — cache-only never generates speculatively.
      return;
    }

    // Cache is full for this mood — play the rotation, no new generation.
    if (cached.length >= this.opts.cacheSizePerMood && cached.length > 0) {
      this.trackQueue = shuffle([...cached]);
      this.playCurrentTrack();
      this.moodStartedAt = Date.now();
    } else if ((this.quotaExceeded || this.generatorUnavailable) && cached.length > 0) {
      // Generation blocked (quota or unavailable) but we have *something*
      // cached — play it rather than silence, even below the nominal cap.
      this.trackQueue = shuffle([...cached]);
      this.playCurrentTrack();
      this.moodStartedAt = Date.now();
    } else if (this.quotaExceeded || this.generatorUnavailable) {
      // Generation blocked and nothing cached — don't interrupt whatever is
      // currently playing; just surface the warning.
      updateState({ generating: false });
    } else {
      const wasPlaying = this.player.isPlaying();
      if (!wasPlaying) {
        updateState({ playing: false });
      }
      updateState({ generating: true });

      try {
        const isInstrumental = !this.opts.vocals || mood === "welcome";
        const prompt = this.buildPrompt(mood, !isInstrumental);
        const result = await this.withGenLock(async () => {
          if (useCache) {
            const freshCache = getCachedTracks(mood);
            if (freshCache.length >= this.opts.cacheSizePerMood) {
              return { kind: "cache" as const, tracks: freshCache };
            }
          }
          const path = await this.generator.generateTrack({
            mood,
            musicPrompt: prompt,
            lyrics,
            instrumental: isInstrumental,
          });
          // Fold existing cached tracks in after the new one for instant variety.
          const rotation = useCache
            ? [path, ...shuffle(getCachedTracks(mood).filter((p) => p !== path))]
            : [path];
          return { kind: "generated" as const, tracks: rotation };
        });

        if (this.currentMood !== mood) return;

        // Generation succeeded — now it's safe to clear one-shot steering.
        // If we'd cleared it before the call and the API failed, the user's
        // once-scoped "play more metal" would silently evaporate.
        this.consumeOneShotSteering();
        updateState({ generating: false });
        this.trackQueue =
          result.kind === "cache" ? shuffle([...result.tracks]) : result.tracks;
        this.playCurrentTrack();
        this.moodStartedAt = Date.now();
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          this.quotaExceeded = true;
          this.currentMood = null;
          updateState({
            generating: false,
            quotaExceeded: true,
            currentMood: null,
            error: err.message,
          });
          return;
        }
        if (err instanceof GeneratorUnavailableError) {
          this.generatorUnavailable = true;
          this.currentMood = null;
          updateState({
            generating: false,
            currentMood: null,
            error: err.message,
          });
          return;
        }
        this.currentMood = null;
        updateState({
          generating: false,
          currentMood: null,
          error: `Generation failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    this.prefetchNextMood(mood);
  }

  private playCurrentTrack(): void {
    if (this.trackQueue.length === 0) return;
    const track = this.trackQueue[this.trackIndex % this.trackQueue.length];
    this.player.play(track);
    updateState({
      playing: true,
      currentTrack: track.split("/").pop() ?? null,
      error: null,
    });
  }

  private playNext(): void {
    if (this.trackQueue.length === 0) return;
    this.trackIndex = (this.trackIndex + 1) % this.trackQueue.length;
    this.playCurrentTrack();
  }

  private async prefetchNextMood(currentMood: Mood): Promise<void> {
    // Speculative — skip if gen is busy, vocals mode (session-specific
    // lyrics can't be speculated), quota is out, or cache-only mode (never
    // generates, period).
    if (
      this.genBusy ||
      this.opts.vocals ||
      this.quotaExceeded ||
      this.generatorUnavailable ||
      this.opts.cacheOnlyMode
    ) return;
    // Skip prefetch whenever session- or one-shot steering is active. The
    // prefetched track would be cached under `target`'s directory and later
    // reused by *other* sessions (with their own steering), baking the
    // current session's preferences into the shared cache. Stick to the
    // persistent config for speculative generation only.
    if (
      this.sessionExcludedGenres.length > 0 ||
      this.excludedGenresOnce.length > 0 ||
      this.genreHintOnce !== null
    ) {
      return;
    }
    const candidates = MOOD_TRANSITIONS[currentMood] ?? [];
    // Prefetch into moods whose cache is below the cap — this is the
    // mechanism that builds variety over time. Once every adjacent mood is
    // at cap, prefetch stops doing anything.
    const target = candidates.find(
      (m) => getCachedTracks(m).length < this.opts.cacheSizePerMood
    );
    if (!target) return;

    try {
      const prompt =
        this.generator.promptStyle === "musicgen"
          ? buildLocalMusicPrompt(
              target,
              this.opts.excludedGenres,
              this.opts.interestingVibes,
              this.opts.genreHint
            )
          : buildMusicPrompt(
              target,
              this.opts.excludedGenres,
              this.opts.interestingVibes,
              false,
              this.opts.genreHint
            );
      await this.withGenLock(async () => {
        // Re-check inside the lock — another generation may have landed
        // in this mood's cache while we were waiting our turn. Must match
        // the outer selection threshold (cap) or prefetch plateaus at 1
        // track per adjacent mood, defeating the warmup/variety model.
        if (getCachedTracks(target).length >= this.opts.cacheSizePerMood) return;
        await this.generator.generateTrack({
          mood: target,
          musicPrompt: prompt,
          lyrics: null,
          instrumental: true,
        });
      });
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        this.quotaExceeded = true;
        updateState({ quotaExceeded: true, error: err.message });
      } else if (err instanceof GeneratorUnavailableError) {
        this.generatorUnavailable = true;
        updateState({ error: err.message });
      }
      // Otherwise non-critical — speculative prefetch.
    }
  }

  private effectiveExcludedGenres(): string[] {
    return [
      ...new Set([
        ...this.opts.excludedGenres,
        ...this.sessionExcludedGenres,
        ...this.excludedGenresOnce,
      ]),
    ];
  }

  private effectiveGenreHint(): string | null {
    return this.genreHintOnce ?? this.opts.genreHint ?? null;
  }

  private consumeOneShotSteering(): void {
    this.genreHintOnce = null;
    this.excludedGenresOnce = [];
  }

  pause(): void {
    this.player.pause();
    updateState({ paused: true });
  }

  resume(): void {
    this.player.resume();
    updateState({ paused: false });
  }

  stop(): void {
    this.clearPromoteTimer();
    this.player.stop();
    this.currentMood = null;
    this.pendingMood = null;
    updateState({
      playing: false,
      paused: false,
      currentMood: null,
      currentTrack: null,
      trackLabel: null,
      pendingMood: null,
    });
  }

  setVolume(vol: number): void {
    const clamped = Math.max(0, Math.min(1, vol));
    this.volume = clamped;
    this.player.setVolume(clamped);
    updateState({ volume: clamped });
  }

  getVolume(): number {
    return this.volume;
  }

  setVocals(enabled: boolean): void {
    this.opts.vocals = enabled;
    updateState({ vocals: enabled });
  }

  setPersistentGenreHint(hint: string | null): void {
    this.opts.genreHint = hint;
  }

  applyGenreSteer(params: {
    hint?: string | null;
    exclude?: string[];
    scope: "once" | "session" | "persistent";
  }): void {
    const { hint, exclude, scope } = params;

    if (hint !== undefined) {
      if (scope === "once") {
        this.genreHintOnce = hint;
      } else if (scope === "session") {
        this.opts.genreHint = hint;
      }
      // persistent is handled by daemon (writes config), which also calls setPersistentGenreHint
    }

    if (exclude && exclude.length > 0) {
      if (scope === "once") {
        this.excludedGenresOnce = [
          ...new Set([...this.excludedGenresOnce, ...exclude]),
        ];
      } else if (scope === "session") {
        this.sessionExcludedGenres = [
          ...new Set([...this.sessionExcludedGenres, ...exclude]),
        ];
      }
      // persistent excludes are also handled by the daemon
    }

    updateState({ genreHint: this.effectiveGenreHint() });
  }

  addPersistentExcludedGenres(ids: string[]): void {
    this.opts.excludedGenres = [
      ...new Set([...this.opts.excludedGenres, ...ids]),
    ];
  }

  play(): void {
    if (this.player.isPlaying()) return;
    if (this.trackQueue.length > 0) {
      this.playCurrentTrack();
      return;
    }
    this.applyMood("welcome", null).catch(() => {});
  }

  getCurrentMood(): Mood | null {
    return this.currentMood;
  }

  getPendingMood(): Mood | null {
    return this.pendingMood?.mood ?? null;
  }

  isPlaying(): boolean {
    return this.player.isPlaying();
  }
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
