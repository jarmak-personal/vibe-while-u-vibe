#!/usr/bin/env node
// CI-safe smoke test: verifies the full classifier → playlist → generateTrack
// wiring without needing the `claude` CLI or the ElevenLabs API. Both
// dist/claude-headless.js and dist/elevenlabs.js are temporarily swapped
// for mocks that return canned values and record calls. Originals restored
// in the finally block.
//
// The point: catch regressions where the lyrics/mood string stops threading
// cleanly through Playlist.switchMood → generateTrack, even if nobody on the
// team can run the live smoke tests locally. Runs in GitHub Actions.

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

const EL_REAL = join(DIST, "elevenlabs.js");
const EL_BACKUP = join(DIST, "elevenlabs.js.bak");
const CH_REAL = join(DIST, "claude-headless.js");
const CH_BACKUP = join(DIST, "claude-headless.js.bak");

const CAPTURE = join(DIST, "mock-capture.json");
const FAKE_MP3 = join(DIST, "mock-track.mp3");

const CANNED_MOOD = "focus";
const CANNED_LYRICS = `[intro]
canned intro for ci
[verse]
stub verse line one
stub verse line two
[chorus]
ci chorus line
[outro]
canned outro`;

if (!existsSync(FAKE_MP3)) writeFileSync(FAKE_MP3, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
const fakeMp3Escaped = FAKE_MP3.replaceAll("\\", "\\\\");
const captureEscaped = CAPTURE.replaceAll("\\", "\\\\");

const EL_MOCK_SRC = `
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

const CH_MOCK_SRC = `
// Mock: short-circuits claude --print. Returns mood on the first call
// (classifier step) and lyrics on the second (lyrics step).
let calls = 0;
export async function claudeHeadless(_prompt, _systemPrompt, _model) {
  calls++;
  if (calls === 1) return ${JSON.stringify(CANNED_MOOD)};
  return ${JSON.stringify(CANNED_LYRICS)};
}
`;

function swap(real, backup, mockSrc) {
  if (!existsSync(backup)) copyFileSync(real, backup);
  writeFileSync(real, mockSrc);
}
function restore(real, backup) {
  if (existsSync(backup)) renameSync(backup, real);
}

let exitCode = 0;
try {
  swap(EL_REAL, EL_BACKUP, EL_MOCK_SRC);
  swap(CH_REAL, CH_BACKUP, CH_MOCK_SRC);
  writeFileSync(CAPTURE, "[]");

  const { initClassifier, pushEvent, setSessionCwd, classifyVibe } =
    await import("../dist/vibe-classifier.js");
  const { Playlist } = await import("../dist/playlist.js");

  initClassifier();
  const sessionId = "smoke-ci-session";
  setSessionCwd(sessionId, process.cwd());

  const now = Date.now();
  // The events don't matter — the mock ignores them — but we push some
  // anyway to make sure the classifier's buffer plumbing is exercised.
  for (let i = 0; i < 4; i++) {
    pushEvent(sessionId, {
      type: "PostToolUse",
      toolName: "Bash",
      toolInput: { command: `echo ${i}` },
      timestamp: now + i * 1000,
    });
  }

  const result = await classifyVibe({
    sessionId,
    generateLyrics: true,
    skipLyricsIfMoodEquals: null,
  });

  if (result.mood !== CANNED_MOOD) {
    console.log(`❌ mood mismatch: expected ${CANNED_MOOD}, got ${result.mood}`);
    exitCode = 1;
  }
  if (result.lyrics !== CANNED_LYRICS) {
    console.log("❌ lyrics mismatch between classifier output and canned value");
    exitCode = 1;
  }

  const playlist = new Playlist({
    volume: 0,
    excludedGenres: [],
    interestingVibes: null,
    vocals: true,
    genreHint: null,
    cacheSizePerMood: 3,
    cacheOnlyMode: false,
  });

  await playlist.switchMood(result.mood, result.lyrics, true);
  await new Promise((r) => setImmediate(r));

  const captured = JSON.parse(readFileSync(CAPTURE, "utf-8"));
  if (captured.length === 0) {
    console.log("❌ generateTrack was never called");
    exitCode = 1;
  } else {
    const call = captured[captured.length - 1];
    if (call.opts.mood !== CANNED_MOOD) {
      console.log(`❌ generateTrack mood=${call.opts.mood}, expected ${CANNED_MOOD}`);
      exitCode = 1;
    }
    if (call.opts.instrumental !== false) {
      console.log(`❌ generateTrack instrumental=${call.opts.instrumental}, expected false`);
      exitCode = 1;
    }
    if (call.opts.lyrics !== CANNED_LYRICS) {
      console.log("❌ generateTrack received lyrics that don't match classifier output");
      exitCode = 1;
    }
  }

  playlist.stop();

  if (exitCode === 0) {
    console.log("✅ smoke-ci: classifier → playlist → generateTrack wiring intact");
  }
} finally {
  restore(EL_REAL, EL_BACKUP);
  restore(CH_REAL, CH_BACKUP);
  rmSync(CAPTURE, { force: true });
  rmSync(FAKE_MP3, { force: true });
}

process.exit(exitCode);
