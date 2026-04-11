#!/usr/bin/env node
// End-to-end wiring smoke test: verifies that the lyrics string produced by
// classifyVibe reaches elevenlabs.generateTrack unchanged when routed through
// Playlist.switchMood. Runs with dist/elevenlabs.js temporarily replaced by a
// mock that captures the GenerateOptions it receives. Restores the original
// in a finally block.
//
// LOCAL-ONLY. classifyVibe shells out to the `claude` CLI, which isn't
// available in CI. Run with `npm run test:smoke`.

import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, "..", "dist");
const REAL = join(DIST, "elevenlabs.js");
const BACKUP = join(DIST, "elevenlabs.js.bak");
const CAPTURE = join(DIST, "mock-capture.json");
const FAKE_MP3 = join(DIST, "mock-track.mp3");

if (!existsSync(FAKE_MP3)) writeFileSync(FAKE_MP3, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
const fakeMp3Escaped = FAKE_MP3.replaceAll("\\", "\\\\");
const captureEscaped = CAPTURE.replaceAll("\\", "\\\\");

const MOCK_SRC = `
// Auto-generated mock. Captures generateTrack calls to a JSON file.
import { writeFileSync, readFileSync } from "node:fs";

export class QuotaExceededError extends Error {
  constructor(message) { super(message); this.name = "QuotaExceededError"; }
}
export function initElevenLabs(_apiKey) {}
export function getCachedTracks(_mood) { return []; }
export async function generateTrack(opts) {
  let prev = [];
  try { prev = JSON.parse(readFileSync(${JSON.stringify(captureEscaped)}, "utf-8")); } catch {}
  prev.push({ at: Date.now(), opts });
  writeFileSync(${JSON.stringify(captureEscaped)}, JSON.stringify(prev, null, 2));
  return ${JSON.stringify(fakeMp3Escaped)};
}
`;

// Swap
if (!existsSync(BACKUP)) copyFileSync(REAL, BACKUP);
writeFileSync(REAL, MOCK_SRC);
writeFileSync(CAPTURE, "[]");

try {
  const { initClassifier, pushEvent, setSessionCwd, classifyVibe } =
    await import("../dist/vibe-classifier.js");
  const { Playlist } = await import("../dist/playlist.js");

  initClassifier();
  const sessionId = "wiring-smoke";
  setSessionCwd(sessionId, process.cwd());

  const now = Date.now();
  const events = [
    { type: "UserPromptSubmit", prompt: "rewrite the HTTP route handlers in server.ts to use zod validation" },
    { type: "PostToolUse", toolName: "Read", toolInput: { file_path: "src/server.ts" } },
    { type: "PostToolUse", toolName: "Edit", toolInput: { file_path: "src/server.ts", old_string: "req.body.userId", new_string: "UserSchema.parse(req.body).userId" } },
    { type: "PostToolUse", toolName: "Bash", toolInput: { command: "npm run typecheck" }, toolResponse: "0 errors" },
  ];
  for (let i = 0; i < events.length; i++) {
    pushEvent(sessionId, { ...events[i], timestamp: now + i * 1000 });
  }

  const result = await classifyVibe({
    sessionId,
    generateLyrics: true,
    skipLyricsIfMoodEquals: null,
  });
  console.log(`classifier → mood=${result.mood}`);
  console.log(`classifier → lyrics (${result.lyrics?.length ?? 0} chars):`);
  console.log(result.lyrics);

  const playlist = new Playlist({
    volume: 0,
    excludedGenres: [],
    interestingVibes: null,
    vocals: true,
    genreHint: null,
    cacheSizePerMood: 3,
    cacheOnlyMode: false,
  });

  // immediate=true forces preparePending to run now instead of deferred.
  await playlist.switchMood(result.mood, result.lyrics, true);

  // preparePending awaits generateTrack inline when immediate=true, so the
  // capture should exist by the time switchMood returns. Give it one tick
  // just in case something in the chain is microtask-deferred.
  await new Promise((r) => setImmediate(r));

  const captured = JSON.parse(readFileSync(CAPTURE, "utf-8"));
  if (captured.length === 0) {
    console.log("\n❌ generateTrack was NEVER called");
    process.exitCode = 1;
  } else {
    const call = captured[captured.length - 1];
    console.log(`\n── generateTrack call captured ──`);
    console.log(`mood:         ${call.opts.mood}`);
    console.log(`instrumental: ${call.opts.instrumental}`);
    console.log(`musicPrompt:  ${call.opts.musicPrompt?.slice(0, 80)}…`);
    console.log(`lyrics len:   ${call.opts.lyrics?.length ?? 0}`);
    const match = call.opts.lyrics === result.lyrics;
    console.log(`lyrics match: ${match ? "✅" : "❌"}`);
    if (!match) {
      console.log("── classifier lyrics ──\n" + result.lyrics);
      console.log("── captured lyrics ──\n" + call.opts.lyrics);
      process.exitCode = 1;
    }
    if (call.opts.instrumental !== false) {
      console.log("❌ instrumental flag should be false (vocals:true)");
      process.exitCode = 1;
    }
  }

  playlist.stop();
} finally {
  if (existsSync(BACKUP)) {
    renameSync(BACKUP, REAL);
  }
  rmSync(CAPTURE, { force: true });
  rmSync(FAKE_MP3, { force: true });
  console.log("(restored dist/elevenlabs.js)");
}
