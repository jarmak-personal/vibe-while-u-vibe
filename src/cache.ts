import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getVibeDir } from "./config.js";
import type { Mood } from "./moods.js";

// Two physically separate caches. The playlist rotation only ever reads the
// instrumental cache (see getCachedTracks below) so a user who toggles
// vocals on, runs a bit, then toggles back off won't hear yesterday's lyric
// tracks bleed through their instrumental rotation.
//
// Layout:
//   ~/.vibe/cache/instrumental/<mood>/*.mp3  ← rotated
//   ~/.vibe/cache/vocals/<mood>/*.mp3        ← kept around for /vibe where,
//                                              never rotated (every vocal
//                                              track is session-specific)
export function getCacheDir(mood: Mood, instrumental: boolean): string {
  const variant = instrumental ? "instrumental" : "vocals";
  const dir = join(getVibeDir(), "cache", variant, mood);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// Playlist rotation always wants instrumental tracks — vocal tracks are
// one-shot and never reused.
export function getCachedTracks(mood: Mood): string[] {
  const dir = getCacheDir(mood, true);
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".mp3"))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}
