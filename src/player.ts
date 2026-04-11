import { spawn, spawnSync, type ChildProcess } from "node:child_process";

type Backend =
  | { kind: "afplay" }
  | { kind: "ffplay" }
  | { kind: "powershell" };

function detectBackend(): Backend {
  switch (process.platform) {
    case "darwin":
      return { kind: "afplay" };
    case "linux": {
      const check = spawnSync("ffplay", ["-version"], { stdio: "ignore" });
      if (check.status !== 0) {
        throw new Error(
          "ffplay not found. Install ffmpeg (e.g. `sudo apt install ffmpeg`) to enable audio playback."
        );
      }
      return { kind: "ffplay" };
    }
    case "win32":
      return { kind: "powershell" };
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

// Run detection once and cache the result (or the error). Deferred so that
// a missing Linux ffplay surfaces via state.error instead of killing the
// daemon at startup when the Playlist is constructed.
let cachedBackend: Backend | null = null;
let cachedBackendError: string | null = null;
function getBackend(): { backend: Backend | null; error: string | null } {
  if (cachedBackend) return { backend: cachedBackend, error: null };
  if (cachedBackendError) return { backend: null, error: cachedBackendError };
  try {
    cachedBackend = detectBackend();
    return { backend: cachedBackend, error: null };
  } catch (err) {
    cachedBackendError = err instanceof Error ? err.message : String(err);
    return { backend: null, error: cachedBackendError };
  }
}

// Builds a PowerShell `-Command` argument that plays an mp3 via Windows Media
// Player COM. We wrap everything in `& { ... }` with positional args instead
// of passing parameters after `-Command`, because PowerShell's `-Command` flag
// absorbs trailing args into the command string rather than binding them to
// the embedded script's param() block. Also: the param is named $AudioPath,
// not $File, to avoid colliding with PowerShell's own top-level `-File` CLI
// flag if parsing ever gets confused.
function buildWinPlayCommand(filePath: string, volume: number): string {
  // Escape single quotes by doubling them (PowerShell's literal-string escape).
  const escapedPath = filePath.replace(/'/g, "''");
  const volumePct = Math.round(Math.max(0, Math.min(1, volume)) * 100);
  return `& {
    param([string]$AudioPath, [int]$Volume)
    $ErrorActionPreference = 'Stop'
    $wmp = New-Object -ComObject WMPlayer.OCX
    $wmp.settings.autoStart = $true
    $wmp.settings.volume = $Volume
    $wmp.URL = $AudioPath
    # playState: 3=playing, 8=mediaEnded, 1=stopped, 10=ready, 9=transitioning
    $deadline = (Get-Date).AddSeconds(10)
    while ($wmp.playState -ne 3 -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 100
    }
    while ($wmp.playState -eq 3 -or $wmp.playState -eq 9 -or $wmp.playState -eq 10) {
      Start-Sleep -Milliseconds 250
    }
  } -AudioPath '${escapedPath}' -Volume ${volumePct}`;
}

export class Player {
  private process: ChildProcess | null = null;
  private currentFile: string | null = null;
  private volume: number;
  private onEndCallback: (() => void) | null = null;

  constructor(volume = 0.3) {
    this.volume = volume;
  }

  /**
   * Check whether an audio backend is available on this platform. Returns
   * null when playback is possible, or a user-visible error string when the
   * required binary is missing. Callers should surface the error through
   * state.json rather than throwing — the daemon must stay alive so the
   * status line can show the message.
   */
  getBackendError(): string | null {
    return getBackend().error;
  }

  play(filePath: string): void {
    const { backend, error } = getBackend();
    if (!backend) {
      // Silently no-op. The daemon has already surfaced `error` via state,
      // and there's nothing play() can do without a backend.
      return;
    }
    this.stopProcess();
    this.currentFile = filePath;

    const { cmd, args } = this.buildCommand(filePath, backend);
    const proc = spawn(cmd, args, {
      stdio: "ignore",
      windowsHide: true,
    });
    this.process = proc;

    proc.on("close", (code) => {
      const wasNaturalEnd = code === 0;
      // Only clear state if this is still the active process — a rapid
      // play()→play() can swap the process before the old one's close
      // fires, and we don't want the stale close to null out the new proc.
      if (this.process === proc) {
        this.process = null;
        if (wasNaturalEnd && this.onEndCallback) {
          this.onEndCallback();
        }
      }
    });

    proc.on("error", () => {
      if (this.process === proc) {
        this.process = null;
      }
    });
  }

  private buildCommand(filePath: string, backend: Backend): { cmd: string; args: string[] } {
    switch (backend.kind) {
      case "afplay":
        return {
          cmd: "afplay",
          args: ["-v", String(this.volume), filePath],
        };
      case "ffplay":
        return {
          cmd: "ffplay",
          args: [
            "-nodisp",
            "-autoexit",
            "-loglevel", "quiet",
            "-volume", String(Math.round(this.volume * 100)),
            filePath,
          ],
        };
      case "powershell":
        return {
          cmd: "powershell.exe",
          args: [
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-Command", buildWinPlayCommand(filePath, this.volume),
          ],
        };
    }
  }

  private stopProcess(): void {
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
  }

  stop(): void {
    this.stopProcess();
    this.currentFile = null;
  }

  // Pause/resume is approximated as stop/replay — none of the backends we use
  // support live pause. Resume restarts the current track from the beginning.
  pause(): void {
    this.stopProcess();
  }

  resume(): void {
    if (this.currentFile && !this.process) {
      this.play(this.currentFile);
    }
  }

  isPlaying(): boolean {
    return this.process !== null;
  }

  getCurrentFile(): string | null {
    return this.currentFile;
  }

  setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(1, vol));
    // Applies on next play — no backend we use supports live volume changes.
  }

  onEnd(callback: () => void): void {
    this.onEndCallback = callback;
  }
}
