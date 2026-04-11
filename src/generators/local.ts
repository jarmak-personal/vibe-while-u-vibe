import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalConfig } from "../config.js";
import { getCacheDir } from "../cache.js";
import {
  type GenerateOptions,
  type MusicGenerator,
  GeneratorUnavailableError,
} from "./types.js";

const READY_MARKER = "VIBE_WORKER_READY";
const READY_TIMEOUT_MS = 120_000; // Cold-start + model load. Large models can take 60s+.
const REQUEST_TIMEOUT_MS = 10 * 60_000; // 10 minutes — large model, long clip.
const HEALTH_POLL_INTERVAL_MS = 250;
const HEALTH_READY_TIMEOUT_MS = 5_000;

/**
 * Supervises a Python worker subprocess that hosts a MusicGen model and
 * serves HTTP generation requests over loopback. Lifecycle:
 *
 *   init()     → spawn worker, wait for VIBE_WORKER_READY on stdout
 *   generate() → POST /generate (one in flight thanks to playlist genLock)
 *   shutdown() → SIGTERM the worker and drop the handle
 *
 * If the worker dies between calls, the next generate() will see a closed
 * socket and throw GeneratorUnavailableError — the playlist catches it and
 * sticks `generatorUnavailable`. We don't auto-restart here; recovery
 * requires a daemon restart so the user sees a clear error instead of the
 * daemon silently cycling a crashed worker forever.
 */
export class LocalGenerator implements MusicGenerator {
  readonly name = "local-musicgen";
  readonly promptStyle = "musicgen" as const;
  private proc: ChildProcess | null = null;
  private readyPromise: Promise<void> | null = null;
  private readonly token: string;
  private readonly port: number;
  private readonly config: LocalConfig;

  constructor(config: LocalConfig) {
    this.config = config;
    this.port = config.workerPort;
    this.token = randomBytes(16).toString("hex");
  }

  async init(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.spawnAndWait();
    return this.readyPromise;
  }

  async shutdown(): Promise<void> {
    this.killWorker();
  }

  async generateTrack(opts: GenerateOptions): Promise<string> {
    if (!opts.instrumental) {
      // Should never happen — daemon/setup force vocals off in local mode.
      // Defensive: if something slips through, surface it clearly rather
      // than silently producing instrumental and confusing the user.
      throw new Error("LocalGenerator does not support vocals");
    }
    try {
      await this.init();
    } catch (err) {
      if (err instanceof GeneratorUnavailableError) throw err;
      throw new GeneratorUnavailableError(
        err instanceof Error ? err.message : String(err)
      );
    }
    if (!this.proc || this.proc.killed || this.proc.exitCode !== null) {
      throw new GeneratorUnavailableError(
        "Local worker is not running. Restart the daemon (e.g. end and start a Claude Code session) or re-run `npm run setup`."
      );
    }

    const cacheDir = getCacheDir(opts.mood, true);
    const filename = `${opts.mood}-${randomUUID().slice(0, 8)}.mp3`;
    const outputPath = join(cacheDir, filename);
    const tmpPath = outputPath + ".tmp";

    const body = {
      prompt: opts.musicPrompt,
      // MusicGen can generate clips up to ~30s comfortably. Going longer
      // is possible but quality drops and memory climbs. 30s loops well
      // enough once the playlist's loop-on-finish handler kicks in.
      duration_s: 30,
      output_path: tmpPath,
    };

    let response: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        response = await fetch(`http://127.0.0.1:${this.port}/generate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Vibe-Token": this.token,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // Connection refused / timeout / reset — worker is likely dead.
      try { unlinkSync(tmpPath); } catch { /* no tmp yet */ }
      throw new GeneratorUnavailableError(
        `Local worker request failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!response.ok) {
      let msg = `worker returned HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { error?: string };
        if (body?.error) msg = body.error;
      } catch { /* non-JSON body */ }
      try { unlinkSync(tmpPath); } catch { /* worker never wrote one */ }
      throw new Error(`Local generation failed: ${msg}`);
    }

    if (!existsSync(tmpPath)) {
      throw new Error(
        "Local generation returned OK but no output file was written"
      );
    }
    renameSync(tmpPath, outputPath);
    return outputPath;
  }

  private async spawnAndWait(): Promise<void> {
    const workerPath = resolveWorkerPath();
    if (!existsSync(workerPath)) {
      throw new GeneratorUnavailableError(
        `Python worker script not found at ${workerPath}. Run \`npm run setup:local\` or reinstall.`
      );
    }
    if (!existsSync(this.config.pythonPath)) {
      throw new GeneratorUnavailableError(
        `Python venv not found at ${this.config.pythonPath}. Run \`npm run setup:local\` to create it.`
      );
    }
    ensureDir(this.config.modelCacheDir);

    const proc = spawn(
      this.config.pythonPath,
      [
        workerPath,
        "--port", String(this.port),
        "--size", this.config.size,
        "--device", this.config.device,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          VIBE_WORKER_TOKEN: this.token,
          // audiocraft reads HF_HOME for model downloads — redirecting the
          // cache here keeps everything under ~/.vibe/models so uninstall
          // can clean it up in one shot.
          HF_HOME: this.config.modelCacheDir,
          TRANSFORMERS_CACHE: this.config.modelCacheDir,
        },
      }
    );
    this.proc = proc;

    // Stderr → daemon stderr, unmodified, so crash tracebacks surface in
    // the daemon log. No filter — MusicGen prints a ton of warnings on
    // first run that are harmless.
    proc.stderr?.on("data", (chunk) => {
      process.stderr.write(`[worker] ${chunk}`);
    });

    // Watch stdout for VIBE_WORKER_READY. Don't swallow other lines —
    // let them through for debugging.
    const rl = createInterface({ input: proc.stdout! });
    const readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectReady(
          new GeneratorUnavailableError(
            `Local worker did not become ready within ${READY_TIMEOUT_MS / 1000}s. Model load may be stuck — check daemon logs.`
          )
        );
      }, READY_TIMEOUT_MS);

      rl.on("line", (line) => {
        if (line.includes(READY_MARKER)) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolveReady();
          return;
        }
        // Pass-through other lines for debugging.
        process.stderr.write(`[worker] ${line}\n`);
      });

      proc.on("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        rejectReady(
          new GeneratorUnavailableError(
            `Local worker exited before ready (code=${code}, signal=${signal}). Check daemon logs.`
          )
        );
      });

      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        rejectReady(
          new GeneratorUnavailableError(
            `Failed to spawn local worker: ${err.message}`
          )
        );
      });
    });

    try {
      await readyPromise;
    } catch (err) {
      this.killWorker();
      throw err;
    }

    // Double-check via /health — belt and suspenders, also confirms the
    // token + HTTP plumbing actually works before the first real request.
    const healthy = await this.probeHealth();
    if (!healthy) {
      this.killWorker();
      throw new GeneratorUnavailableError(
        "Local worker printed READY but /health probe failed — aborting."
      );
    }
  }

  private async probeHealth(): Promise<boolean> {
    const deadline = Date.now() + HEALTH_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEALTH_POLL_INTERVAL_MS);
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`, {
          signal: controller.signal,
        });
        if (res.ok) return true;
      } finally {
        clearTimeout(timer);
      }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
    }
    return false;
  }

  private killWorker(): void {
    if (!this.proc) return;
    try {
      if (!this.proc.killed) this.proc.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    this.proc = null;
    this.readyPromise = null;
  }
}

/**
 * Resolves the worker script path relative to the compiled daemon. The
 * daemon runs from `dist/daemon.js`; `python/worker.py` lives at the
 * repo root, so `../python/worker.py` from dist/ works in dev and in
 * an installed package (where `files: ["dist"]` in package.json means
 * we need to also ship `python/`).
 */
function resolveWorkerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/generators/local.js → ../../python/worker.py
  return resolve(here, "..", "..", "python", "worker.py");
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}
