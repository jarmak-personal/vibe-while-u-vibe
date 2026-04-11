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

// Wipe dist/skills and dist/skill-guidance before copying fresh. tsc leaves
// removed source files behind in dist/, so without this a renamed or deleted
// skill (e.g. the old hidden `vibe-local` / `vibe-elevenlabs` sub-skills)
// would stick around in dist/ and get republished forever.
rmSync(join(distDir, "skills"), { recursive: true, force: true });
rmSync(join(distDir, "skill-guidance"), { recursive: true, force: true });

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
const skillsSrc = join(srcDir, "skills");
if (existsSync(skillsSrc)) {
  for (const entry of readdirSync(skillsSrc, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillSrc = join(skillsSrc, entry.name, "SKILL.md");
    if (!existsSync(skillSrc)) continue;
    copyFile(skillSrc, join(distDir, "skills", entry.name, "SKILL.md"));
  }
}

// 4. Backend-specific guidance for the `vibe` skill.
// These are *not* Claude Code skills — they're plain markdown that the main
// vibe skill Reads on demand after inspecting config.provider. Shipped under
// dist/skill-guidance/ and installed to ~/.vibe/skill-guidance/ so they
// don't leak into every session's context the way hidden sub-skills do.
const guidanceSrc = join(srcDir, "skill-guidance");
if (existsSync(guidanceSrc)) {
  for (const entry of readdirSync(guidanceSrc, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    copyFile(
      join(guidanceSrc, entry.name),
      join(distDir, "skill-guidance", entry.name)
    );
  }
}
