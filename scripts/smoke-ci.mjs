#!/usr/bin/env node
// CI-safe smoke test: verifies the full classifier → playlist → generator
// wiring without needing the `claude` CLI or the ElevenLabs API.
//
// The classifier is mocked by module-swapping dist/claude-headless.js (there's
// no injection seam for it). The generator is mocked via dependency injection
// — we build a MusicGenerator object inline and pass it into new Playlist.
//
// The point: catch regressions where the lyrics/mood string stops threading
// cleanly through Playlist.switchMood → generator.generateTrack, even if
// nobody on the team can run the live smoke tests locally. Runs in GitHub
// Actions.

import {
  copyFileSync,
  existsSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, "..", "dist");

const CH_REAL = join(DIST, "claude-headless.js");
const CH_BACKUP = join(DIST, "claude-headless.js.bak");
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
  swap(CH_REAL, CH_BACKUP, CH_MOCK_SRC);

  const { initClassifier, pushEvent, setSessionCwd, classifyVibe } =
    await import("../dist/vibe-classifier.js");
  const { Playlist } = await import("../dist/playlist.js");

  // In-memory mock generator. Captures every generateTrack call so we can
  // assert the mood/lyrics/instrumental flags threaded through cleanly.
  const captured = [];
  const mockGenerator = {
    name: "mock",
    async init() {},
    async shutdown() {},
    async generateTrack(opts) {
      captured.push({ at: Date.now(), opts });
      return FAKE_MP3;
    },
  };

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
    generator: mockGenerator,
  });

  await playlist.switchMood(result.mood, result.lyrics, true);
  await new Promise((r) => setImmediate(r));

  if (captured.length === 0) {
    console.log("❌ generator.generateTrack was never called");
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
    console.log("✅ smoke-ci: classifier → playlist → generator wiring intact");
  }
} finally {
  restore(CH_REAL, CH_BACKUP);
  rmSync(FAKE_MP3, { force: true });
}

process.exit(exitCode);
