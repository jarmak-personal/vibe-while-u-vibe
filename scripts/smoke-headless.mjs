#!/usr/bin/env node
// Smoke test: exercises classifyVibe + generateSessionLyrics end-to-end
// against the compiled classifier, using a fabricated event stream that
// mimics a real debug session. Prints the classified mood + full lyrics.
//
// LOCAL-ONLY. Shells out to the `claude` CLI, which isn't available in CI
// (GHA, etc.). Run with `npm run test:smoke`.

import {
  initClassifier,
  pushEvent,
  setSessionCwd,
  classifyVibe,
} from "../dist/vibe-classifier.js";

initClassifier();

const sessionId = "smoke-test-session";
setSessionCwd(sessionId, process.cwd());

const now = Date.now();
const events = [
  { type: "UserPromptSubmit", prompt: "the lyrics are coming out totally generic — why?" },
  { type: "PostToolUse", toolName: "Read", toolInput: { file_path: "src/vibe-classifier.ts" } },
  { type: "PostToolUse", toolName: "Bash", toolInput: { command: "tail -40 ~/.vibe/daemon.log" }, toolResponse: "lyrics call failed: claude --print failed: Warning: no stdin data received in 3s, proceeding without it." },
  { type: "PostToolUse", toolName: "Grep", toolInput: { pattern: "claudeHeadless", path: "src" } },
  { type: "PostToolUse", toolName: "Edit", toolInput: { file_path: "src/vibe-classifier.ts", old_string: 'execFile("claude"', new_string: 'spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] })' } },
  { type: "PostToolUse", toolName: "Bash", toolInput: { command: "npm run build" }, toolResponse: "tsc && node scripts/copy-assets.mjs" },
];

for (let i = 0; i < events.length; i++) {
  pushEvent(sessionId, { ...events[i], timestamp: now + i * 1000 });
}

console.log("Classifying…");
const t0 = Date.now();
const result = await classifyVibe({
  sessionId,
  generateLyrics: true,
  skipLyricsIfMoodEquals: null,
});
const elapsed = Date.now() - t0;

console.log(`\n── result (${elapsed}ms) ──`);
console.log(`mood:   ${result.mood}`);
console.log(`lyrics:\n${result.lyrics ?? "(none)"}`);
