#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  loadConfig,
  saveConfig,
} from "./config.js";
import type { Mood } from "./moods.js";
import { CLASSIFIABLE_MOODS } from "./moods.js";
import {
  writePidFile,
  writePortFile,
  removePidFile,
  removePortFile,
  resetState,
  updateState,
  getState,
  isDaemonRunning,
} from "./state.js";
import { createGenerator } from "./generators/index.js";
import {
  initClassifier,
  pushEvent as pushClassifierEvent,
  shouldReclassify,
  classifyVibe,
  dropSession as dropClassifierSession,
  setSessionCwd,
} from "./vibe-classifier.js";
import { Playlist } from "./playlist.js";
import {
  type SessionState,
  getEventWeight,
  pickActiveSession,
} from "./priority.js";

const config = loadConfig();

// ── Singleton guard ──
// Top-level await is fine here — package.json sets type: module and the
// daemon is always run via `node dist/daemon.js`, which accepts TLA on
// every supported Node version.
if (await isDaemonRunning()) {
  // Already running — this is fine, hooks will find the existing port file
  process.exit(0);
}

// ── Initialize generator ──
// createGenerator handles provider selection and credential validation.
// If the real generator can't be built (e.g. missing API key) it returns
// a StubGenerator and a non-null degradedReason — the daemon stays alive
// and surfaces the reason via state.error so the status line can show it.
const { generator, degradedReason } = await createGenerator(config);
if (degradedReason) {
  console.error(degradedReason);
}

// Warm the generator in the background so daemon startup stays fast. Local
// MusicGen load can take 30-120s; generation calls will await the same init
// promise if they arrive before warmup completes.
void generator.init().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  updateState({ error: message });
});

initClassifier();

// ── Playlist (single global player) ──
const playlist = new Playlist({
  volume: config.volume,
  excludedGenres: config.excludedGenres,
  interestingVibes: config.interestingVibes,
  vocals: config.vocals,
  genreHint: config.genreHint,
  cacheSizePerMood: config.cacheSizePerMood,
  cacheOnlyMode: config.cacheOnlyMode,
  generator,
});

// Note: config-derived state fields (vocals, genreHint) are written in the
// startup block near server.listen(), *after* resetState(). Writing them
// here instead gets clobbered by the later reset.

// ── Multi-session tracking ──
const sessions = new Map<string, SessionState>();
let currentActiveSessionId: string | null = null;
let classifying = false;
let moodLock = false;

// Grace period after the last session ends. If a new session appears within
// this window (e.g. user closed and reopened Claude Code), we cancel the
// shutdown and keep the daemon alive — avoids thrashing the player and
// re-paying welcome-music generation cost.
const SHUTDOWN_GRACE_MS = 10_000;
let shutdownTimer: NodeJS.Timeout | null = null;

function getOrCreateSession(sessionId: string): SessionState {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      sessionId,
      currentMood: null,
      currentLyrics: null,
      lastEventTime: Date.now(),
      lastEventWeight: 0,
      alive: true,
    };
    sessions.set(sessionId, session);
    // A new session showed up — cancel any pending shutdown.
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
      console.log("New session arrived during grace period — staying alive.");
    }
    syncSessionCount();
  }
  return session;
}

function removeSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.alive = false;
  }
  sessions.delete(sessionId);
  dropClassifierSession(sessionId);
  syncSessionCount();

  // If all sessions are gone, schedule a graceful shutdown. A new session
  // starting within SHUTDOWN_GRACE_MS will cancel it.
  if (sessions.size === 0 && !shutdownTimer) {
    console.log(
      `All sessions ended. Shutting down in ${SHUTDOWN_GRACE_MS / 1000}s unless a new session arrives.`
    );
    shutdownTimer = setTimeout(() => {
      shutdownTimer = null;
      if (sessions.size === 0) {
        console.log("Grace period elapsed. Shutting down.");
        shutdown();
      }
    }, SHUTDOWN_GRACE_MS);
  }
}

function syncSessionCount(): void {
  updateState({ activeSessions: sessions.size });
}

// ── Event handling ──
async function handleEvent(body: Record<string, unknown>): Promise<void> {
  const sessionId = String(body.session_id ?? "unknown");
  const hookEvent = String(body.hook_event_name ?? "unknown");
  const toolName = body.tool_name as string | undefined;

  const session = getOrCreateSession(sessionId);

  // Track the session's working directory for git repo context in lyrics.
  if (typeof body.cwd === "string") {
    setSessionCwd(sessionId, body.cwd);
  }

  // Update session priority
  const weight = getEventWeight(hookEvent, toolName);
  session.lastEventTime = Date.now();
  session.lastEventWeight = weight;

  // Feed event to classifier, scoped to this session
  pushClassifierEvent(sessionId, {
    type: hookEvent,
    timestamp: Date.now(),
    toolName,
    toolInput: body.tool_input as Record<string, unknown> | undefined,
    toolResponse: body.tool_response,
    prompt: body.prompt as string | undefined,
  });

  // Pick which session should drive the music
  const active = pickActiveSession(sessions);
  const activeId = active?.sessionId ?? null;

  // Session switch — but don't cut the current track.
  // The playlist defers mood changes until track boundaries.
  if (activeId !== currentActiveSessionId) {
    currentActiveSessionId = activeId;
    updateState({ activeSession: activeId });
  }

  // Reclassify if needed (only for the active session, and only when the
  // mood isn't locked by an explicit /vibe setMood command)
  if (
    activeId === sessionId &&
    shouldReclassify(sessionId) &&
    !classifying &&
    !moodLock
  ) {
    await runClassification(session);
  }
}

async function runClassification(session: SessionState): Promise<void> {
  classifying = true;
  try {
    const { mood, lyrics } = await classifyVibe({
      sessionId: session.sessionId,
      generateLyrics: config.vocals,
      skipLyricsIfMoodEquals: playlist.getCurrentMood(),
    });
    session.currentMood = mood;
    session.currentLyrics = lyrics;
    await playlist.switchMood(mood, lyrics);
  } catch (err) {
    updateState({
      error: `Classification failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    classifying = false;
  }
}

function handleSessionEnd(body: Record<string, unknown>): void {
  const sessionId = String(body.session_id ?? "unknown");
  removeSession(sessionId);
}

// ── Control commands ──
function handleControl(body: Record<string, unknown>): { ok: boolean; error?: string } {
  const action = String(body.action ?? "");
  switch (action) {
    case "pause":
      playlist.pause();
      return { ok: true };
    case "resume":
      playlist.resume();
      return { ok: true };
    case "skip":
      playlist.skip();
      return { ok: true };
    case "stop":
      playlist.stop();
      return { ok: true };
    case "play":
      playlist.play();
      return { ok: true };
    case "volume": {
      if (typeof body.value !== "number" || !Number.isFinite(body.value)) {
        return { ok: false, error: "volume: 'value' must be a number between 0 and 1" };
      }
      playlist.setVolume(body.value);
      return { ok: true };
    }
    case "volumeDelta": {
      if (typeof body.delta !== "number" || !Number.isFinite(body.delta)) {
        return { ok: false, error: "volumeDelta: 'delta' must be a finite number" };
      }
      playlist.setVolume(playlist.getVolume() + body.delta);
      return { ok: true };
    }
    case "setMood": {
      const mood = String(body.mood ?? "");
      // `welcome` is startup-only; don't let users lock into it.
      if (!CLASSIFIABLE_MOODS.includes(mood as Mood)) {
        return { ok: false, error: `invalid mood: ${mood}` };
      }
      const lock = body.lock !== false; // default true
      const immediate = body.immediate !== false; // default true
      const lyrics = (body.lyrics as string | null | undefined) ?? null;
      moodLock = lock;
      updateState({ moodLocked: lock });
      playlist.switchMood(mood as Mood, lyrics, immediate).catch(() => {});
      return { ok: true };
    }
    case "unlockMood":
      moodLock = false;
      updateState({ moodLocked: false });
      return { ok: true };
    case "setVocals": {
      const enabled = Boolean(body.enabled);
      if (config.provider === "local" && enabled) {
        return {
          ok: false,
          error: "local backend is instrumental-only; vocals are unavailable",
        };
      }
      playlist.setVocals(enabled);
      config.vocals = enabled;
      saveConfig(config);
      return { ok: true };
    }
    case "reclassify": {
      const active = pickActiveSession(sessions);
      if (active && !classifying) {
        // Force classification regardless of debounce/lock
        const wasLocked = moodLock;
        moodLock = false;
        runClassification(active).finally(() => {
          if (wasLocked) {
            moodLock = true;
            updateState({ moodLocked: true });
          }
        });
      }
      return { ok: true };
    }
    case "genreSteer": {
      const hint = body.hint as string | null | undefined;
      const exclude = Array.isArray(body.exclude) ? (body.exclude as string[]) : [];
      const scope = (body.scope as string) ?? "once";
      if (scope !== "once" && scope !== "session" && scope !== "persistent") {
        return { ok: false, error: `invalid scope: ${scope}` };
      }

      playlist.applyGenreSteer({ hint, exclude, scope });

      if (scope === "persistent") {
        if (hint !== undefined) {
          config.genreHint = hint;
          playlist.setPersistentGenreHint(hint);
        }
        if (exclude.length > 0) {
          config.excludedGenres = [
            ...new Set([...config.excludedGenres, ...exclude]),
          ];
          playlist.addPersistentExcludedGenres(exclude);
        }
        saveConfig(config);
      }
      return { ok: true };
    }
    default:
      return { ok: false, error: `unknown action: ${action}` };
  }
}


// ── HTTP plumbing ──
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  try {
    if (method === "POST" && url === "/event") {
      const raw = await readBody(req);
      const body = JSON.parse(raw);

      // SessionEnd is handled specially — removes session
      if (body.hook_event_name === "SessionEnd") {
        handleSessionEnd(body);
      } else {
        handleEvent(body).catch(() => {});
      }
      sendJson(res, 200, { ok: true });
    } else if (method === "POST" && url === "/control") {
      const raw = await readBody(req);
      const body = JSON.parse(raw);
      const result = handleControl(body);
      sendJson(res, result.ok ? 200 : 400, {
        ...result,
        state: getState(),
      });
    } else if (method === "GET" && url === "/status") {
      sendJson(res, 200, {
        ...getState(),
        sessions: [...sessions.keys()],
        pendingMood: playlist.getPendingMood(),
      });
    } else if (method === "GET" && url === "/health") {
      sendJson(res, 200, {
        alive: true,
        pid: process.pid,
        sessions: sessions.size,
      });
    } else {
      sendJson(res, 404, { error: "not found" });
    }
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : "internal error",
    });
  }
});

// ── Lifecycle ──
function shutdown(): void {
  console.log("Vibe daemon shutting down...");
  playlist.stop();
  // Fire-and-forget — local backend's shutdown sends SIGTERM to the worker.
  // We don't await it because process.exit happens immediately after; the
  // worker handles its own SIGTERM cleanly via its signal handler.
  generator.shutdown().catch(() => {});
  resetState();
  removePidFile();
  removePortFile();
  server.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

writePidFile();
resetState();
updateState({
  volume: config.volume,
  startedAt: Date.now(),
  vocals: config.vocals,
  genreHint: config.genreHint,
});
if (degradedReason) {
  updateState({ error: degradedReason });
}

// Audio backend check. On Linux without ffmpeg this is where we notice —
// the daemon stays alive in a degraded state so the status line can surface
// the install instructions rather than the user seeing silent nothing.
const backendError = playlist.getBackendError();
if (backendError) {
  console.error(backendError);
  updateState({ error: backendError });
}

server.listen(0, "127.0.0.1", () => {
  const addr = server.address() as AddressInfo;
  const port = addr.port;
  writePortFile(port);

  console.log(`Vibe daemon listening on http://127.0.0.1:${port}`);
  console.log(`PID: ${process.pid}`);

  // Welcome music — skip when the generator is degraded or there's no
  // audio backend; the daemon stays up in degraded mode just to keep the
  // status line error visible.
  if (!degradedReason && !backendError) {
    playlist.switchMood("welcome", null).catch((err) => {
      console.error("Welcome music failed:", err);
    });
  }
});
