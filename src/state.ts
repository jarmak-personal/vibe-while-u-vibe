import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getVibeDir, ensureVibeDir } from "./config.js";
import type { Mood } from "./moods.js";

export interface VibeState {
  playing: boolean;
  currentMood: Mood | null;
  pendingMood: Mood | null;
  currentTrack: string | null;
  trackLabel: string | null;
  generating: boolean;
  paused: boolean;
  volume: number;
  startedAt: number | null;
  activeSession: string | null;
  activeSessions: number;
  error: string | null;
  quotaExceeded: boolean;
  moodLocked: boolean;
  vocals: boolean;
  genreHint: string | null;
}

const DEFAULT_STATE: VibeState = {
  playing: false,
  currentMood: null,
  pendingMood: null,
  currentTrack: null,
  trackLabel: null,
  generating: false,
  paused: false,
  volume: 0.3,
  startedAt: null,
  activeSession: null,
  activeSessions: 0,
  error: null,
  quotaExceeded: false,
  moodLocked: false,
  vocals: false,
  genreHint: null,
};

let currentState: VibeState = { ...DEFAULT_STATE };

const STATE_PATH = join(getVibeDir(), "state.json");
const PID_PATH = join(getVibeDir(), "daemon.pid");
const PORT_PATH = join(getVibeDir(), "daemon.port");

export function getState(): VibeState {
  return currentState;
}

export function updateState(patch: Partial<VibeState>): void {
  currentState = { ...currentState, ...patch };
  persistState();
}

export function resetState(): void {
  currentState = { ...DEFAULT_STATE };
  persistState();
}

function persistState(): void {
  ensureVibeDir();
  try {
    writeFileSync(STATE_PATH, JSON.stringify(currentState, null, 2) + "\n");
  } catch {
    // Best effort
  }
}

export function writePidFile(): void {
  ensureVibeDir();
  writeFileSync(PID_PATH, String(process.pid));
}

export function writePortFile(port: number): void {
  ensureVibeDir();
  writeFileSync(PORT_PATH, String(port));
}

export function readPidFile(): number | null {
  if (!existsSync(PID_PATH)) return null;
  try {
    const pid = parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function readPortFile(): number | null {
  if (!existsSync(PORT_PATH)) return null;
  try {
    const port = parseInt(readFileSync(PORT_PATH, "utf-8").trim(), 10);
    return isNaN(port) ? null : port;
  } catch {
    return null;
  }
}

export function removePidFile(): void {
  try {
    unlinkSync(PID_PATH);
  } catch {
    // Already gone
  }
}

export function removePortFile(): void {
  try {
    unlinkSync(PORT_PATH);
  } catch {
    // Already gone
  }
}

// Liveness is gated on BOTH the PID being alive AND the port file pointing
// at a real vibe daemon that responds to /health. Checking only `process.kill
// (pid, 0)` is unsafe because PIDs get recycled after reboots/crashes — a
// stale pid file can collide with an unrelated process, causing the
// singleton guard to no-op (new daemon never starts) or causing uninstall
// to SIGTERM the wrong PID. The /health probe proves "this is our daemon".
export async function isDaemonRunning(): Promise<boolean> {
  const info = await getDaemonHealth();
  return info !== null;
}

export interface DaemonHealth {
  pid: number;
  port: number;
}

// Returns the daemon's real PID + port if it's actually responding on the
// port written to daemon.port, or null if anything looks wrong. Callers
// that need to kill the daemon should use THIS pid, not readPidFile(),
// so they can't accidentally kill a recycled PID.
export async function getDaemonHealth(): Promise<DaemonHealth | null> {
  const port = readPortFile();
  if (port === null) return null;
  const pidFromFile = readPidFile();
  if (pidFromFile === null) return null;
  try {
    process.kill(pidFromFile, 0);
  } catch {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { alive?: boolean; pid?: number };
    if (body?.alive !== true || typeof body.pid !== "number") return null;
    if (body.pid !== pidFromFile) return null;
    return { pid: body.pid, port };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
