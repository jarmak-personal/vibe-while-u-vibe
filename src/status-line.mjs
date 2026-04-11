#!/usr/bin/env node
// Claude Code status line — reads the daemon state file and prints a single
// line. Silent exit on any error (status line must never throw).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const VIBE_DIR = join(homedir(), ".vibe");
const STATE_FILE = join(VIBE_DIR, "state.json");
const PID_FILE = join(VIBE_DIR, "daemon.pid");

if (!existsSync(STATE_FILE)) process.exit(0);

let s;
try {
  s = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
} catch {
  process.exit(0);
}

// Is the daemon process actually alive?
let daemonAlive = false;
if (existsSync(PID_FILE)) {
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (!Number.isNaN(pid)) {
      try {
        process.kill(pid, 0);
        daemonAlive = true;
      } catch {
        // Stale PID file
      }
    }
  } catch {
    // Best effort
  }
}

if (!daemonAlive && !s.currentMood) process.exit(0);

let line = "";
if (s.quotaExceeded && daemonAlive) {
  // Sticky — show even while a cached track keeps playing, since no new
  // music will generate until the user tops up ElevenLabs credits.
  if (s.playing) {
    line = "\u26a0 " + (s.trackLabel || s.currentMood) + " — ElevenLabs out of credits";
  } else {
    line = "\u26a0 vibe: ElevenLabs out of credits (elevenlabs.io/pricing)";
  }
} else if (s.error && daemonAlive && !s.playing && !s.generating) {
  // Surface errors when the daemon is alive but stuck. Truncate to first
  // line and cap length so the status bar stays readable.
  const firstLine = String(s.error).split("\n")[0];
  const short = firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine;
  line = "\u26a0 vibe: " + short;
} else if (s.paused) {
  line = "\u23f8 " + (s.trackLabel || s.currentMood);
} else if (s.generating && !s.playing) {
  line = "\u23f3 Generating " + (s.trackLabel || s.currentMood) + "...";
} else if (s.playing) {
  line = "\u266b " + (s.trackLabel || s.currentMood);
  if (s.generating) line += " +";
} else if (daemonAlive) {
  line = "\u266b vibe: idle";
}

if (s.activeSessions > 1) {
  line += " [" + s.activeSessions + " sessions]";
}

if (line) process.stdout.write(line);
