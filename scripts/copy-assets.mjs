#!/usr/bin/env node
// Copy non-TS assets into dist/ after `tsc`. Cross-platform replacement for
// the previous shell-based copy step.

import { copyFileSync, mkdirSync, readdirSync, existsSync, chmodSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const srcDir = join(root, "src");
const distDir = join(root, "dist");

// Clean up any stale legacy shell scripts from earlier builds so dist/ only
// contains the current (cross-platform) asset set.
for (const stale of [
  join(distDir, "status-line.sh"),
  join(distDir, "hooks", "start-daemon.sh"),
  join(distDir, "hooks", "stop-daemon.sh"),
  join(distDir, "hooks", "send-event.sh"),
]) {
  rmSync(stale, { force: true });
}

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function copyFile(src, dest, executable = false) {
  ensureDir(dirname(dest));
  copyFileSync(src, dest);
  if (executable && process.platform !== "win32") {
    chmodSync(dest, 0o755);
  }
}

// 1. Hook scripts
const hooksSrc = join(srcDir, "hooks");
const hooksDest = join(distDir, "hooks");
ensureDir(hooksDest);
for (const file of readdirSync(hooksSrc)) {
  if (file.endsWith(".mjs")) {
    copyFile(join(hooksSrc, file), join(hooksDest, file), true);
  }
}

// 2. Status line
copyFile(join(srcDir, "status-line.mjs"), join(distDir, "status-line.mjs"), true);

// 3. Skill markdown
const skillSrc = join(srcDir, "skills", "vibe", "SKILL.md");
if (existsSync(skillSrc)) {
  copyFile(skillSrc, join(distDir, "skills", "vibe", "SKILL.md"));
}
