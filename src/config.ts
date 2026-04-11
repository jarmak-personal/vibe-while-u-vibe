import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type Provider = "elevenlabs" | "local";
export type LocalModelSize = "small" | "medium" | "large";
export type LocalDevice = "mps" | "cuda" | "auto";

export interface LocalConfig {
  /** Only "musicgen" is supported today; reserved for future backends. */
  backend: "musicgen";
  size: LocalModelSize;
  /** "auto" resolves at worker startup via torch's device probes. */
  device: LocalDevice;
  /** Port the Python HTTP worker binds to (loopback only). */
  workerPort: number;
  /** Absolute path to the venv python binary — written by install-local.mjs. */
  pythonPath: string;
  /** Absolute path to the HF_HOME-style model cache (defaults to ~/.vibe/models). */
  modelCacheDir: string;
}

export interface VibeConfig {
  elevenLabsApiKey: string | null;
  volume: number;
  port: number;
  enabled: boolean;
  excludedGenres: string[];
  interestingVibes: boolean;
  vocals: boolean;
  genreHint: string | null;
  /**
   * Max cached instrumental tracks kept per mood. Once reached, no new
   * generation happens for that mood — the cached tracks rotate. Vocals
   * mode bypasses the cache entirely so this has no effect there.
   * Higher = more variety, more generation cost burned during warmup.
   */
  cacheSizePerMood: number;
  /**
   * Zero-credit mode: never call the generator. Only play whatever is already
   * cached under ~/.vibe/cache. Useful once warmup is done, or for users
   * who have burned their monthly credits. Moods with an empty cache will
   * stay silent and surface a message via state.error.
   */
  cacheOnlyMode: boolean;
  /** Generation backend selection. */
  provider: Provider;
  /** Local backend config — populated when provider === "local". */
  local: LocalConfig | null;
}

const VIBE_DIR = join(homedir(), ".vibe");
const CONFIG_PATH = join(VIBE_DIR, "config.json");

const DEFAULT_CONFIG: VibeConfig = {
  elevenLabsApiKey: null,
  volume: 0.3,
  port: 7773,
  enabled: true,
  excludedGenres: [],
  interestingVibes: false,
  vocals: false,
  genreHint: null,
  cacheSizePerMood: 3,
  cacheOnlyMode: false,
  provider: "elevenlabs",
  local: null,
};

export function getVibeDir(): string {
  return VIBE_DIR;
}

export function ensureVibeDir(): void {
  if (!existsSync(VIBE_DIR)) {
    mkdirSync(VIBE_DIR, { recursive: true });
  }
  const cacheDir = join(VIBE_DIR, "cache");
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
}

export function loadConfig(): VibeConfig {
  ensureVibeDir();
  let config: VibeConfig;
  if (!existsSync(CONFIG_PATH)) {
    config = { ...DEFAULT_CONFIG };
  } else {
    try {
      const raw = readFileSync(CONFIG_PATH, "utf-8");
      config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch {
      config = { ...DEFAULT_CONFIG };
    }
  }
  // Invariant: local backend cannot do vocals. Force the flag off at load
  // time so no runtime path ever sees an inconsistent state — covers hand-
  // edited config.json and old configs migrated to provider=local.
  if (config.provider === "local") {
    config.vocals = false;
  }
  return config;
}

export function saveConfig(config: VibeConfig): void {
  ensureVibeDir();
  // 0600 — the file holds a plaintext ElevenLabs API key.
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  if (process.platform !== "win32") {
    try { chmodSync(CONFIG_PATH, 0o600); } catch { /* best effort */ }
  }
}

export function getElevenLabsApiKey(config: VibeConfig): string | null {
  // Env var wins over config file — standard 12-factor style, and lets
  // users override a stored key without editing ~/.vibe/config.json.
  return process.env.ELEVENLABS_API_KEY || config.elevenLabsApiKey || null;
}

