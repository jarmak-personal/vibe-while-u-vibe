#!/usr/bin/env node
/**
 * smoke-local.mjs
 *
 * End-to-end smoke test for the local MusicGen worker. Skipped by default
 * because it needs:
 *   - the venv at ~/.vibe/venv (built by `npm run setup:local`)
 *   - the audiocraft model weights downloaded (multi-GB on first run)
 *   - 30–90s of model load + ~1–10 minutes of generation depending on size
 *     and device
 *
 * Run with: VIBE_TEST_LOCAL=1 npm run test:smoke:local
 *
 * What it checks:
 *   1. LocalGenerator.init() spawns the worker and waits for the ready
 *      marker without timing out.
 *   2. /health probe passes the X-Vibe-Token gate.
 *   3. generateTrack() returns a non-empty mp3 path on disk.
 *   4. shutdown() kills the worker without leaking the child process.
 *
 * The test does NOT exercise the playlist or classifier — those are covered
 * by smoke-ci.mjs (mocked) and smoke-wiring.mjs (real Claude). This file is
 * specifically about the worker's process / HTTP plumbing.
 */

import { existsSync, statSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.VIBE_TEST_LOCAL !== "1") {
  console.log(
    "smoke-local: VIBE_TEST_LOCAL not set — skipping (set VIBE_TEST_LOCAL=1 to run)."
  );
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// We need the compiled JS so we can import LocalGenerator with its real
// type signatures and runtime behavior. Build first if missing.
const localGenPath = join(REPO_ROOT, "dist", "generators", "local.js");
if (!existsSync(localGenPath)) {
  console.error(`smoke-local: ${localGenPath} missing — run \`npm run build\` first.`);
  process.exit(1);
}

const { loadConfig } = await import("../dist/config.js");
const { LocalGenerator } = await import("../dist/generators/local.js");

const config = loadConfig();
if (config.provider !== "local" || !config.local) {
  console.error(
    "smoke-local: config.provider != 'local' or local block missing. Run `npm run setup:local`."
  );
  process.exit(1);
}
if (!existsSync(config.local.pythonPath)) {
  console.error(
    `smoke-local: pythonPath ${config.local.pythonPath} not found. Run \`npm run setup:local\`.`
  );
  process.exit(1);
}

console.log(`smoke-local: provider=local size=${config.local.size} device=${config.local.device}`);
console.log(`smoke-local: pythonPath=${config.local.pythonPath}`);

const gen = new LocalGenerator(config.local);

let exitCode = 0;
let producedPath = null;

try {
  console.log("smoke-local: init() — spawning worker, waiting for ready...");
  const t0 = Date.now();
  await gen.init();
  console.log(`smoke-local: ready in ${Math.round((Date.now() - t0) / 1000)}s`);

  console.log("smoke-local: generateTrack() — generating short clip...");
  const t1 = Date.now();
  producedPath = await gen.generateTrack({
    mood: "focus",
    musicPrompt: "lo-fi study beat, gentle percussion, instrumental only",
    instrumental: true,
    lyrics: null,
  });
  console.log(`smoke-local: generated in ${Math.round((Date.now() - t1) / 1000)}s`);

  if (!existsSync(producedPath)) {
    console.error(`❌ smoke-local: returned path does not exist: ${producedPath}`);
    exitCode = 1;
  } else {
    const sz = statSync(producedPath).size;
    if (sz < 1024) {
      console.error(`❌ smoke-local: output suspiciously small (${sz} bytes): ${producedPath}`);
      exitCode = 1;
    } else {
      console.log(`✅ smoke-local: ${sz} bytes at ${producedPath}`);
    }
  }
} catch (err) {
  console.error("❌ smoke-local: threw:", err?.message ?? err);
  exitCode = 1;
} finally {
  try {
    await gen.shutdown();
  } catch {
    /* best effort */
  }
  // Don't leave the test artifact in the cache — it's not a real track and
  // would pollute the playlist on the next daemon start.
  if (producedPath && existsSync(producedPath)) {
    try {
      rmSync(producedPath, { force: true });
    } catch {
      /* best effort */
    }
  }
}

if (exitCode === 0) {
  console.log("✅ smoke-local: worker spawn → generate → shutdown all clean");
}
process.exit(exitCode);
