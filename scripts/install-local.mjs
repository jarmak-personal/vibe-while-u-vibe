#!/usr/bin/env node
/**
 * install-local.mjs
 *
 * Bootstraps the local MusicGen worker:
 *   1. Ensures `uv` is installed (idempotent — no-op if present).
 *   2. Creates a venv at ~/.vibe/venv pinned to Python 3.11 (audiocraft is
 *      currently picky about newer Pythons).
 *   3. Installs torch + torchaudio from the right wheel index for the host:
 *        - macOS (any arch)        → default PyPI (MPS works on Apple Silicon)
 *        - Linux/Win + Nvidia GPU  → https://download.pytorch.org/whl/cu121
 *        - Linux/Win, no GPU       → https://download.pytorch.org/whl/cpu
 *      Detection of Nvidia is via `nvidia-smi -L`. CPU mode is supported but
 *      we warn loudly because MusicGen on CPU is unusably slow (minutes per
 *      30s clip).
 *   4. Installs audiocraft from python/requirements.txt.
 *   5. Patches ~/.vibe/config.json with provider="local" and a populated
 *      `local` block (pythonPath, modelCacheDir, default size/device, port).
 *
 * Re-running is safe: each step checks state before acting and exits cleanly
 * if there's nothing to do.
 *
 * Args: --size <small|medium|large>  default: medium
 *       --device <auto|mps|cuda|cpu> default: auto
 *       --cuda <version|none>        default: unset (use PyTorch's default PyPI
 *                                    wheel, which currently bundles CUDA 12.x).
 *                                    Example: --cuda 12.4 → cu124 wheel index,
 *                                    --cuda 12.8 → cu128, --cuda none → same as
 *                                    unset (no --index-url).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, platform, arch } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve relative to *this* script, not cwd — setup.ts spawns us with cwd
// pointing at the repo root, but a future caller might not.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const REQUIREMENTS_PATH = join(REPO_ROOT, "python", "requirements.txt");

const VIBE_DIR = join(homedir(), ".vibe");
const VENV_DIR = join(VIBE_DIR, "venv");
const MODEL_CACHE_DIR = join(VIBE_DIR, "models");
const CONFIG_PATH = join(VIBE_DIR, "config.json");

const IS_WINDOWS = platform() === "win32";
const PY_BIN = IS_WINDOWS
  ? join(VENV_DIR, "Scripts", "python.exe")
  : join(VENV_DIR, "bin", "python");

const args = parseArgs(process.argv.slice(2));
const size = args.size ?? "medium";
const device = args.device ?? "auto";
const cudaArg = args.cuda ?? null; // e.g. "12.4", "12.8", "none", or null

if (!["small", "medium", "large"].includes(size)) {
  fail(`--size must be one of small|medium|large (got: ${size})`);
}
if (!["auto", "mps", "cuda", "cpu"].includes(device)) {
  fail(`--device must be one of auto|mps|cuda|cpu (got: ${device})`);
}
if (cudaArg !== null && cudaArg !== "none" && !/^\d+\.\d+$/.test(cudaArg)) {
  fail(`--cuda must be "none" or a major.minor version like 12.4 (got: ${cudaArg})`);
}

main().catch((err) => {
  console.error("\n[install-local] FAILED:", err.message ?? err);
  process.exit(1);
});

async function main() {
  ensureDir(VIBE_DIR);
  ensureDir(MODEL_CACHE_DIR);

  banner("vibe-while-u-vibe :: local backend installer");
  console.log(`  Platform: ${platform()} ${arch()}`);
  console.log(`  Vibe dir: ${VIBE_DIR}`);
  console.log(`  Model size: ${size}`);
  console.log("");

  // 1. Ensure uv
  ensureUv();

  // 2. Create venv
  createVenv();

  // 3. Install torch + audiocraft
  const torchPlan = decideTorchInstall();
  installTorch(torchPlan);
  installAudiocraft();

  // 4. Patch config
  patchConfig(torchPlan);

  banner("Local backend installed!");
  console.log("  Next: re-run `npm run setup` (or just start a Claude Code");
  console.log("  session) — the daemon will spawn the Python worker on boot.");
  console.log("");
  console.log(`  Models will land in: ${MODEL_CACHE_DIR}`);
  console.log("  First generation downloads ~1.5–13 GB of weights depending on");
  console.log("  the chosen size, and takes 30–90s to load on subsequent boots.");
  console.log("");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--size") out.size = argv[++i];
    else if (a === "--device") out.device = argv[++i];
    else if (a === "--cuda") out.cuda = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log(
        "Usage: node scripts/install-local.mjs [--size small|medium|large] [--device auto|mps|cuda|cpu] [--cuda <major.minor>|none]"
      );
      process.exit(0);
    }
  }
  return out;
}

function ensureUv() {
  step("Checking for uv");
  const probe = spawnSync("uv", ["--version"], { stdio: "ignore" });
  if (probe.status === 0) {
    console.log("  uv already installed.");
    return;
  }

  console.log("  uv not found — installing.");
  if (IS_WINDOWS) {
    // Official PowerShell installer. Runs synchronously.
    const ps = spawnSync(
      "powershell",
      [
        "-ExecutionPolicy",
        "ByPass",
        "-Command",
        "irm https://astral.sh/uv/install.ps1 | iex",
      ],
      { stdio: "inherit" }
    );
    if (ps.status !== 0) {
      fail(
        "uv install failed. Install manually from https://docs.astral.sh/uv/ and re-run."
      );
    }
  } else {
    // sh -c so the curl | sh idiom works under both bash and zsh and we
    // don't depend on a specific shell binary.
    const sh = spawnSync(
      "sh",
      ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"],
      { stdio: "inherit" }
    );
    if (sh.status !== 0) {
      fail(
        "uv install failed. Install manually from https://docs.astral.sh/uv/ and re-run."
      );
    }
  }

  // After install, uv is at ~/.local/bin/uv (macOS/Linux) or
  // %USERPROFILE%\.local\bin\uv.exe (Windows). PATH might not be refreshed
  // in the current process — verify before continuing.
  const recheck = spawnSync("uv", ["--version"], { stdio: "ignore" });
  if (recheck.status !== 0) {
    fail(
      "uv installed but not on PATH yet. Open a new shell and re-run `npm run setup:local`."
    );
  }
}

function createVenv() {
  step("Creating Python 3.11 venv");
  if (existsSync(PY_BIN)) {
    console.log(`  Venv already exists at ${VENV_DIR}.`);
    return;
  }
  // uv venv downloads a managed CPython if the host doesn't have 3.11.
  // --python 3.11 is required because audiocraft 1.3.0 doesn't ship wheels
  // for 3.13 yet, and 3.12 has spotty torch support on some platforms.
  const r = spawnSync(
    "uv",
    ["venv", VENV_DIR, "--python", "3.11"],
    { stdio: "inherit" }
  );
  if (r.status !== 0) {
    fail("uv venv failed — see output above.");
  }
  if (!existsSync(PY_BIN)) {
    fail(`Venv created but ${PY_BIN} is missing — aborting.`);
  }
}

function decideTorchInstall() {
  // Returns { kind, indexArgs, label } describing how to install torch.
  //
  //   kind = "default"     → no --index-url; pip gets whatever PyPI ships,
  //                          which for torch on Linux/Windows currently
  //                          bundles a recent CUDA 12.x runtime. This is
  //                          the PyTorch-recommended path for CUDA 12.x
  //                          users and macOS (MPS ships in the default
  //                          wheel). Forward-compat with CUDA 13 drivers.
  //   kind = "cuda-pinned" → --index-url cu{major}{minor} because the user
  //                          explicitly requested a CTK-matched wheel.
  //   kind = "cpu"         → --index-url cpu for Linux/Windows hosts with
  //                          no Nvidia GPU, or when --device cpu is set.
  //
  // macOS: always default (CUDA wheels don't exist for Darwin).
  if (platform() === "darwin") {
    return { kind: "default", indexArgs: [], label: "default (macOS / MPS)" };
  }

  // Explicit CPU override.
  if (device === "cpu") {
    return {
      kind: "cpu",
      indexArgs: ["--index-url", "https://download.pytorch.org/whl/cpu"],
      label: "cpu (forced via --device cpu)",
    };
  }

  // Probe for Nvidia. nvidia-smi exits non-zero if no driver/GPU.
  const smi = spawnSync("nvidia-smi", ["-L"], { stdio: "pipe" });
  const hasGpu =
    smi.status === 0 && /GPU \d+:/.test(smi.stdout?.toString() ?? "");

  if (!hasGpu) {
    console.warn(
      "  WARNING: no Nvidia GPU detected. Falling back to CPU torch wheels."
    );
    console.warn(
      "  MusicGen on CPU is *very* slow (multiple minutes per 30s clip)."
    );
    console.warn(
      "  Consider --device cpu only for testing the wiring, not for daily use."
    );
    return {
      kind: "cpu",
      indexArgs: ["--index-url", "https://download.pytorch.org/whl/cpu"],
      label: "cpu (no Nvidia GPU detected)",
    };
  }

  console.log(
    `  Detected Nvidia GPU: ${smi.stdout.toString().trim().split("\n")[0]}`
  );

  // User passed --cuda <x.y>: map to cu{XY} wheel index.
  if (cudaArg && cudaArg !== "none") {
    const [maj, min] = cudaArg.split(".");
    const suffix = `cu${maj}${min}`;
    return {
      kind: "cuda-pinned",
      indexArgs: [
        "--index-url",
        `https://download.pytorch.org/whl/${suffix}`,
      ],
      label: `CUDA ${cudaArg} (${suffix} wheel index)`,
    };
  }

  // Default GPU path: no --index-url. PyPI's default torch wheel bundles a
  // recent CUDA 12.x runtime and is forward-compat with CUDA 13 drivers. We
  // don't pin a minor version so this stays current as PyTorch rolls forward.
  return {
    kind: "default",
    indexArgs: [],
    label: "default (PyPI latest — bundles CUDA 12.x runtime)",
  };
}

function installTorch(plan) {
  step(`Installing torch + torchaudio — ${plan.label}`);
  const r = spawnSync(
    "uv",
    [
      "pip",
      "install",
      "--python",
      PY_BIN,
      "torch",
      "torchaudio",
      ...plan.indexArgs,
    ],
    { stdio: "inherit" }
  );
  if (r.status !== 0) {
    fail("torch install failed — see output above.");
  }
}

function installAudiocraft() {
  step("Installing audiocraft");
  // Use the requirements.txt rather than inlining the version so the pin
  // lives in one place. uv pip install -r works the same as pip's flag.
  if (!existsSync(REQUIREMENTS_PATH)) {
    fail(
      `Requirements file not found at ${REQUIREMENTS_PATH} — reinstall the package.`
    );
  }
  const r = spawnSync(
    "uv",
    ["pip", "install", "--python", PY_BIN, "-r", REQUIREMENTS_PATH],
    { stdio: "inherit" }
  );
  if (r.status !== 0) {
    fail("audiocraft install failed — see output above.");
  }
}

function patchConfig(torchPlan) {
  step("Updating ~/.vibe/config.json");

  let config = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    } catch {
      console.warn("  Existing config.json is not valid JSON; rewriting.");
      config = {};
    }
  }

  // Pick a sensible default device based on platform + torch plan.
  // The Python worker re-checks at startup if device==="auto", so this is
  // really just a hint for the user reading config.json.
  let defaultDevice = device;
  if (defaultDevice === "auto") {
    if (platform() === "darwin") defaultDevice = "mps";
    else if (torchPlan.kind === "cpu") defaultDevice = "cpu";
    else defaultDevice = "cuda";
  }

  config.provider = "local";
  // Local backend can't do vocals — force off so the daemon never even tries.
  config.vocals = false;
  config.local = {
    backend: "musicgen",
    size,
    device: defaultDevice,
    workerPort: config?.local?.workerPort ?? 7774,
    pythonPath: PY_BIN,
    modelCacheDir: MODEL_CACHE_DIR,
  };

  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  if (!IS_WINDOWS) {
    try {
      chmodSync(CONFIG_PATH, 0o600);
    } catch {
      /* best effort */
    }
  }
  console.log(`  Wrote local config: size=${size} device=${defaultDevice}`);
}

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function step(msg) {
  console.log(`\n── ${msg} ──`);
}

function banner(msg) {
  const bar = "═".repeat(msg.length + 4);
  console.log(`\n╔${bar}╗`);
  console.log(`║  ${msg}  ║`);
  console.log(`╚${bar}╝\n`);
}

function fail(msg) {
  console.error(`\n[install-local] ${msg}`);
  process.exit(1);
}
