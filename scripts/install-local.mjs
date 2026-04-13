#!/usr/bin/env node
/**
 * install-local.mjs
 *
 * Bootstraps the local music worker (ACE-Step or MusicGen fallback):
 *   1. Ensures `uv` is installed (idempotent — no-op if present).
 *   2. Creates a venv at ~/.vibe/venv pinned to Python 3.11.
 *   3. Verifies system ffmpeg is installed for mp3 encoding.
 *   4. Installs torch + torchaudio from the right wheel index for the host.
 *   5. Installs model-specific dependencies (ace-step or audiocraft).
 *   6. Patches ~/.vibe/config.json with provider="local" and a populated
 *      `local` block (pythonPath, modelCacheDir, backend, device, port).
 *
 * Re-running is safe: each step checks state before acting and exits cleanly
 * if there's nothing to do.
 *
 * Args: --backend <ace-step|musicgen>   default: auto-detect from hardware
 *       --size <small|medium|large>     default: medium (musicgen only)
 *       --dit-model <model-id>          ACE-Step DiT model
 *       --lm-model <model-id>           ACE-Step LM model (optional)
 *       --device <auto|mps|cuda|cpu>    default: auto
 *       --cuda <version|none>           default: unset (PyTorch default)
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
let UV_BIN = resolveUvBinary() ?? "uv";

const args = parseArgs(process.argv.slice(2));
const installChoice = recommendInstallChoice();
const backend = args.backend ?? installChoice.backend;
const size = args.size ?? installChoice.size ?? "medium";
const ditModel = args["dit-model"] ?? installChoice.ditModel ?? "acestep-v15-turbo";
const lmModel = args["lm-model"] ?? installChoice.lmModel ?? null;
const device = args.device ?? "auto";
const cudaArg = args.cuda ?? null;

if (!["ace-step", "musicgen"].includes(backend)) {
  fail(`--backend must be one of ace-step|musicgen (got: ${backend})`);
}
if (backend === "musicgen" && !["small", "medium", "large"].includes(size)) {
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

  if (platform() === "darwin" && arch() !== "arm64") {
    fail(
      "Local generation is only supported on Apple Silicon Macs. Intel Macs should use the ElevenLabs backend instead."
    );
  }

  banner("vibe-while-u-vibe :: local backend installer");
  console.log(`  Platform: ${platform()} ${arch()}`);
  console.log(`  Vibe dir: ${VIBE_DIR}`);
  if (!args.backend) {
    console.log(`  Selection: auto (${installChoice.reason})`);
  }
  console.log(`  Backend: ${backend}`);
  if (backend === "musicgen") {
    console.log(`  Model size: ${size}`);
  } else {
    console.log(`  DiT model: ${ditModel}`);
    console.log(`  LM model: ${lmModel ?? "(none)"}`);
  }
  console.log("");

  ensureUv();
  createVenv();
  ensureFfmpeg();

  const torchPlan = decideTorchInstall();
  installTorch(torchPlan);

  if (backend === "musicgen") {
    installAudiocraft();
  } else {
    installAceStep();
  }

  patchConfig(torchPlan);

  banner("Local backend installed!");
  console.log("  Next: re-run `npm run setup` (or just start a Claude Code");
  console.log("  session) — the daemon will spawn the Python worker on boot.");
  console.log("");
  console.log(`  Models will land in: ${MODEL_CACHE_DIR}`);
  console.log("");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--backend") out.backend = argv[++i];
    else if (a === "--size") out.size = argv[++i];
    else if (a === "--dit-model") out["dit-model"] = argv[++i];
    else if (a === "--lm-model") out["lm-model"] = argv[++i];
    else if (a === "--device") out.device = argv[++i];
    else if (a === "--cuda") out.cuda = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log(
        "Usage: node scripts/install-local.mjs [--backend ace-step|musicgen] [--size small|medium|large] [--dit-model <id>] [--lm-model <id>] [--device auto|mps|cuda|cpu] [--cuda <major.minor>|none]"
      );
      process.exit(0);
    }
  }
  return out;
}

function ensureUv() {
  step("Checking for uv");
  const existingUv = resolveUvBinary();
  if (existingUv) {
    UV_BIN = existingUv;
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
  const installedUv = resolveUvBinary();
  if (!installedUv) {
    fail(
      "uv install completed, but the binary could not be located. Install manually from https://docs.astral.sh/uv/ and re-run."
    );
  }
  UV_BIN = installedUv;
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
    UV_BIN,
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

function ensureFfmpeg() {
  step("Checking for ffmpeg");
  const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (probe.status === 0) {
    console.log("  ffmpeg already installed.");
    return;
  }
  fail(
    "ffmpeg is required for local generation so output can be encoded as mp3. Install it (e.g. `brew install ffmpeg`) and re-run."
  );
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
      "  Local generation on CPU is *very* slow. Consider --device cpu only for testing."
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
    UV_BIN,
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
  if (!existsSync(REQUIREMENTS_PATH)) {
    fail(
      `Requirements file not found at ${REQUIREMENTS_PATH} — reinstall the package.`
    );
  }
  const r = spawnSync(
    UV_BIN,
    ["pip", "install", "--python", PY_BIN, "-r", REQUIREMENTS_PATH],
    { stdio: "inherit" }
  );
  if (r.status !== 0) {
    fail("audiocraft install failed — see output above.");
  }
}

function installAceStep() {
  step("Installing ACE-Step dependencies");
  const aceReqPath = join(REPO_ROOT, "python", "requirements-ace-step.txt");
  if (!existsSync(aceReqPath)) {
    fail(
      `ACE-Step requirements file not found at ${aceReqPath} — reinstall the package.`
    );
  }
  const r = spawnSync(
    UV_BIN,
    ["pip", "install", "--python", PY_BIN, "-r", aceReqPath],
    { stdio: "inherit" }
  );
  if (r.status !== 0) {
    fail("ACE-Step dependency install failed — see output above.");
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
  config.vocals = false;
  config.local = {
    backend,
    size,
    device: defaultDevice,
    workerPort: config?.local?.workerPort ?? 7774,
    pythonPath: PY_BIN,
    modelCacheDir: MODEL_CACHE_DIR,
  };
  if (backend === "ace-step") {
    config.local.aceStep = {
      ditModel,
      lmModel: lmModel || null,
    };
  }

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
  const backendLabel =
    backend === "ace-step"
      ? `${ditModel}${lmModel ? ` + ${lmModel}` : " (DiT only)"}`
      : `musicgen-${size}`;
  console.log(`  Wrote local config: ${backendLabel}, device=${defaultDevice}`);
}

function recommendInstallChoice() {
  if (platform() === "darwin" && arch() === "arm64") {
    const mem = detectAppleSiliconMemory() ?? 0;
    if (mem < 8) {
      return musicgenRec(
        "small",
        `${mem} GB unified memory: falling back to MusicGen small`
      );
    }
    if (mem < 16) {
      return aceRec(
        "acestep-v15-turbo",
        null,
        `${mem} GB unified memory: ACE-Step turbo DiT only`
      );
    }
    if (mem < 24) {
      return aceRec(
        "acestep-v15-turbo",
        "acestep-5Hz-lm-0.6B",
        `${mem} GB unified memory: ACE-Step turbo + small LM`
      );
    }
    if (mem < 32) {
      return aceRec(
        "acestep-v15-sft",
        "acestep-5Hz-lm-1.7B",
        `${mem} GB unified memory: ACE-Step SFT + medium LM`
      );
    }
    if (mem < 48) {
      return aceRec(
        "acestep-v15-xl-turbo",
        "acestep-5Hz-lm-1.7B",
        `${mem} GB unified memory: ACE-Step XL turbo + medium LM`
      );
    }
    return aceRec(
      "acestep-v15-xl-sft",
      "acestep-5Hz-lm-4B",
      `${mem} GB unified memory: ACE-Step XL SFT + large LM`
    );
  }

  if (platform() === "linux" || platform() === "win32") {
    const vramGb = detectNvidiaVram();
    if (vramGb === undefined) {
      return musicgenRec(
        "small",
        "CPU-only system: falling back to MusicGen small"
      );
    }
    if (vramGb <= 6) {
      return aceRec(
        "acestep-v15-turbo",
        null,
        `${vramGb} GB VRAM: ACE-Step turbo DiT only`
      );
    }
    if (vramGb < 12) {
      return aceRec(
        "acestep-v15-turbo",
        "acestep-5Hz-lm-0.6B",
        `${vramGb} GB VRAM: ACE-Step turbo + small LM`
      );
    }
    if (vramGb < 16) {
      return aceRec(
        "acestep-v15-sft",
        "acestep-5Hz-lm-1.7B",
        `${vramGb} GB VRAM: ACE-Step SFT + medium LM`
      );
    }
    if (vramGb < 20) {
      return aceRec(
        "acestep-v15-xl-turbo",
        "acestep-5Hz-lm-1.7B",
        `${vramGb} GB VRAM: ACE-Step XL turbo + medium LM`
      );
    }
    if (vramGb < 24) {
      return aceRec(
        "acestep-v15-xl-sft",
        "acestep-5Hz-lm-1.7B",
        `${vramGb} GB VRAM: ACE-Step XL SFT + medium LM`
      );
    }
    return aceRec(
      "acestep-v15-xl-sft",
      "acestep-5Hz-lm-4B",
      `${vramGb} GB VRAM: ACE-Step XL SFT + large LM`
    );
  }

  return musicgenRec("small", "Unsupported platform fallback: MusicGen small");
}

function detectAppleSiliconMemory() {
  const r = spawnSync("sysctl", ["-n", "hw.memsize"], { stdio: "pipe" });
  if (r.status !== 0) return undefined;
  const bytes = parseInt(r.stdout.toString().trim(), 10);
  if (Number.isNaN(bytes)) return undefined;
  return Math.round(bytes / (1024 * 1024 * 1024));
}

function detectNvidiaVram() {
  const r = spawnSync(
    "nvidia-smi",
    ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
    { stdio: "pipe" }
  );
  if (r.status !== 0) return undefined;
  const mb = parseInt(r.stdout.toString().trim().split("\n")[0], 10);
  if (Number.isNaN(mb)) return undefined;
  return Math.round(mb / 1024);
}

function aceRec(ditModel, lmModel, reason) {
  return {
    backend: "ace-step",
    ditModel,
    lmModel,
    reason,
  };
}

function musicgenRec(size, reason) {
  return {
    backend: "musicgen",
    size,
    reason,
  };
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

function resolveUvBinary() {
  const candidates = [
    "uv",
    IS_WINDOWS
      ? join(homedir(), ".local", "bin", "uv.exe")
      : join(homedir(), ".local", "bin", "uv"),
  ];

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (probe.status === 0) return candidate;
  }
  return null;
}
