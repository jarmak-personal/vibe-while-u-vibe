#!/usr/bin/env node
// Hook: SessionStart — starts the global vibe daemon if not already running.
// Cross-platform replacement for the old start-daemon.sh.

import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const VIBE_DIR = join(homedir(), ".vibe");
const PID_FILE = join(VIBE_DIR, "daemon.pid");
const PORT_FILE = join(VIBE_DIR, "daemon.port");
const LOG_FILE = join(VIBE_DIR, "daemon.log");
const PINNED_PATH_FILE = join(VIBE_DIR, "daemon-path");
const STATE_FILE = join(VIBE_DIR, "state.json");
const SKILL_DEST = join(homedir(), ".claude", "skills", "vibe", "SKILL.md");
const DISABLED_FILE = join(VIBE_DIR, "disabled");

if (!existsSync(VIBE_DIR)) {
  mkdirSync(VIBE_DIR, { recursive: true });
}

// Kill switch: if ~/.vibe/disabled exists, do not spawn the daemon.
// Delete the file to re-enable. Useful when debugging / saving API credits.
if (existsSync(DISABLED_FILE)) {
  process.exit(0);
}

// ── Locate the daemon script ─────────────────────────────────────────────
// Prefer the pinned path written by `vibe setup`, then fall back to a few
// common install locations.
function findDaemon() {
  if (existsSync(PINNED_PATH_FILE)) {
    const pinned = readFileSync(PINNED_PATH_FILE, "utf-8").trim();
    if (pinned && existsSync(pinned)) return pinned;
  }

  const candidates = [];

  // Sibling to this hook file (relative to install layout)
  const here = dirname(fileURLToPath(import.meta.url));
  candidates.push(resolve(here, "..", "daemon.js"));
  candidates.push(resolve(here, "..", "..", "dist", "daemon.js"));

  // Global npm install
  const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf-8", shell: true });
  if (npmRoot.status === 0) {
    const root = npmRoot.stdout.trim();
    if (root) candidates.push(join(root, "vibe-while-u-vibe", "dist", "daemon.js"));
  }

  // Local install under ~/.vibe
  candidates.push(join(VIBE_DIR, "node_modules", "vibe-while-u-vibe", "dist", "daemon.js"));

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

const daemonScript = findDaemon();
if (!daemonScript) {
  console.error("vibe-while-u-vibe: daemon script not found");
  process.exit(1);
}

// ── Re-sync /vibe skill from dist/ if a newer version exists ─────────────
// The skill markdown is copied to ~/.claude/skills/vibe/SKILL.md at setup
// time. On updates, rerunning setup isn't ergonomic, so we copy it here
// whenever the source is newer than the destination.
function resyncSkill() {
  try {
    const skillSrc = resolve(dirname(daemonScript), "skills", "vibe", "SKILL.md");
    if (!existsSync(skillSrc)) return;
    const skillDestDir = dirname(SKILL_DEST);
    if (!existsSync(skillDestDir)) {
      mkdirSync(skillDestDir, { recursive: true });
    }
    const srcMtime = statSync(skillSrc).mtimeMs;
    const destMtime = existsSync(SKILL_DEST) ? statSync(SKILL_DEST).mtimeMs : 0;
    if (srcMtime > destMtime) {
      copyFileSync(skillSrc, SKILL_DEST);
    }
  } catch {
    // Best effort — resync failures shouldn't block session start.
  }
}

// ── Detect a stale daemon from an older build ────────────────────────────
// Compares the max mtime of dist/*.js against the running daemon's recorded
// startedAt. If anything in dist/ is newer, we recycle the daemon so users
// never have to manually kill it after an update.
function maxDistMtime() {
  const distDir = dirname(daemonScript);
  let max = 0;
  try {
    for (const entry of readdirSync(distDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      try {
        const m = statSync(join(distDir, entry.name)).mtimeMs;
        if (m > max) max = m;
      } catch {
        // File vanished mid-scan — skip.
      }
    }
  } catch {
    // dist/ not readable — skip staleness check.
  }
  return max;
}

function isDaemonStale() {
  try {
    if (!existsSync(STATE_FILE)) return false;
    const state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    if (typeof state.startedAt !== "number") return false;
    return maxDistMtime() > state.startedAt;
  } catch {
    return false;
  }
}

// Synchronous sleep using Atomics.wait — doesn't burn CPU and avoids
// spawning a subprocess. Only used in the rare daemon-recycle path.
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Strong liveness check: returns the real daemon {pid, port} only if the
// port file exists AND /health responds with matching pid. Guards against
// stale pid files where the PID has been recycled by an unrelated process.
async function daemonHealth() {
  if (!existsSync(PORT_FILE) || !existsSync(PID_FILE)) return null;
  let port;
  let pidFromFile;
  try {
    port = parseInt(readFileSync(PORT_FILE, "utf-8").trim(), 10);
    pidFromFile = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
  } catch {
    return null;
  }
  if (!Number.isFinite(port) || !Number.isFinite(pidFromFile)) return null;
  if (!isAlive(pidFromFile)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (body?.alive !== true || body.pid !== pidFromFile) return null;
    return { pid: pidFromFile, port };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function killAndWait(pid, timeoutMs = 3000) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // already dead
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    sleepSync(100);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

// Skill resync runs on every SessionStart regardless of daemon state.
resyncSkill();

// ── Handle existing daemon ────────────────────────────────────────────────
// Use the /health probe (not just pid-file presence) so a recycled PID
// from an unrelated process can't make us either no-op or SIGTERM the
// wrong thing.
const existing = await daemonHealth();
if (existing) {
  if (isDaemonStale()) {
    console.log("vibe: newer build detected, recycling daemon.");
    killAndWait(existing.pid);
    rmSync(PID_FILE, { force: true });
    rmSync(PORT_FILE, { force: true });
    // Fall through to spawn fresh.
  } else {
    // Healthy and up to date — nothing to do.
    process.exit(0);
  }
} else {
  // Either no daemon, or stale state files — clean up before spawning.
  if (existsSync(PID_FILE)) rmSync(PID_FILE, { force: true });
  if (existsSync(PORT_FILE)) rmSync(PORT_FILE, { force: true });
}

// ── Spawn the daemon detached so it outlives this hook process ───────────
// (We don't pre-seed state.json here — the daemon calls resetState() within
// milliseconds of launch, so anything we write would be overwritten.)
//
// Rotate daemon.log when it gets too big. Without this, a long-lived daemon
// accumulates hundreds of MB of log lines across sessions. Cap at ~1 MB —
// anything more isn't useful for debugging anyway.
const LOG_MAX_BYTES = 1024 * 1024;
try {
  if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
    rmSync(LOG_FILE, { force: true });
  }
} catch {
  // Best effort — a stat/remove race with another daemon start isn't fatal.
}

const out = openSync(LOG_FILE, "a");
const err = openSync(LOG_FILE, "a");

const child = spawn(process.execPath, [daemonScript], {
  detached: true,
  stdio: ["ignore", out, err],
  env: { ...process.env, ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY ?? "" },
  windowsHide: true,
});
child.unref();
