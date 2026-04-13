#!/usr/bin/env node

import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform, arch } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, ensureVibeDir, getVibeDir, DEFAULT_ACE_STEP_CONFIG, type LocalModelSize, type LocalBackend } from "./config.js";
import { recommendLocalMusicModel, type HardwareProfile } from "./local-model-selector.js";
import { GENRES } from "./genres.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function main(): Promise<void> {
  console.log("");
  console.log("  ╔══════════════════════════════════════╗");
  console.log("  ║     vibe-while-u-vibe setup          ║");
  console.log("  ║  AI music for your coding sessions   ║");
  console.log("  ╚══════════════════════════════════════╝");
  console.log("");

  const config = loadConfig();
  const previousProvider = config.provider;
  const previousLocal = config.local;
  const previousVocals = config.vocals;

  // ── 1. Backend selection ──
  console.log("  ── Backend ──\n");
  console.log("  ElevenLabs (cloud) — paid API, supports vocals, fast.");
  console.log("    Burns ~1,500 credits/min; Creator tier (~$22/mo) lasts ~35 tracks.");
  console.log("  Local (ACE-Step)   — free, instrumental only, runs on your hardware.");
  console.log("    Needs Apple Silicon (MPS) or Nvidia GPU, plus system ffmpeg. MusicGen fallback for weak hardware.\n");

  const currentBackend = config.provider;
  const backendAnswer = (
    await ask(`  Backend? (elevenlabs/local) [${currentBackend}]: `)
  ).toLowerCase();
  let selectedProvider = currentBackend;
  if (backendAnswer === "local" || backendAnswer === "l") {
    selectedProvider = "local";
  } else if (backendAnswer === "elevenlabs" || backendAnswer === "e") {
    selectedProvider = "elevenlabs";
  }
  config.provider = selectedProvider;
  console.log(`  Backend: ${config.provider}\n`);

  // ── 1a. Local backend setup ──
  // Ask for model size, then shell out to install-local.mjs which sets up
  // uv, the venv, torch + audiocraft, and writes the local config block.
  // After it returns we reload the config so the rest of setup sees the
  // freshly-written `local` section.
  if (config.provider === "local") {
    const localReady = await runLocalBackendSetup(config);
    if (!localReady && !previousLocal) {
      config.provider = previousProvider;
      config.local = previousLocal;
      config.vocals = previousVocals;
      console.log("  Local backend is not configured yet — keeping the previous backend.\n");
    } else {
      // install-local.mjs forces vocals=false; respect that here too.
      config.vocals = false;
    }
  }

  // ── 2. ElevenLabs API key ──
  // Only relevant when provider === "elevenlabs". Local users skip this entire
  // block — no key needed, no key prompted for.
  if (config.provider === "elevenlabs") {
    console.log("  ── API Key ──\n");
    console.log("  Heads up: ElevenLabs Music burns ~1,500 credits/min of audio.");
    console.log("  Tiers stack additively. Monthly totals (3-min tracks):");
    console.log("    Free      10k  →  ~6 min    (~2 tracks)");
    console.log("    Starter   40k  →  ~27 min   (~9 tracks)");
    console.log("    Creator  161k  →  ~107 min  (~35 tracks)  ← recommended");
    console.log("  See elevenlabs.io/pricing.\n");
    const existingKey = config.elevenLabsApiKey;
    const keyPrompt = existingKey
      ? `  ElevenLabs API key [${existingKey.slice(0, 8)}...]: `
      : "  ElevenLabs API key (from elevenlabs.io): ";

    const newKey = await ask(keyPrompt);
    if (newKey) {
      config.elevenLabsApiKey = newKey;
    } else if (!existingKey) {
      console.log("  No key provided. Set ELEVENLABS_API_KEY env var later.\n");
    }
  }

  // ── 2. Volume ──
  console.log("");
  const volAnswer = await ask(`  Volume (0.0-1.0) [${config.volume}]: `);
  if (volAnswer) {
    const vol = parseFloat(volAnswer);
    if (!isNaN(vol) && vol >= 0 && vol <= 1) {
      config.volume = vol;
    }
  }

  // ── 3. Genre preferences ──
  console.log("\n  ── Genre Preferences ──\n");
  console.log("  Which genres do you NOT want to hear? Enter numbers to");
  console.log("  toggle off, separated by spaces. Press Enter to keep all.\n");

  const excluded = new Set(config.excludedGenres);

  GENRES.forEach((g, i) => {
    const num = String(i + 1).padStart(2, " ");
    const status = excluded.has(g.id) ? "OFF" : " ON";
    const marker = excluded.has(g.id) ? "x" : "✓";
    console.log(`    ${num}. [${marker}] ${g.label.padEnd(24)} ${status}`);
  });

  console.log("");
  const genreAnswer = await ask("  Toggle off (e.g. \"5 11 12\"): ");
  if (genreAnswer) {
    const nums = genreAnswer
      .split(/[\s,]+/)
      .map((n) => parseInt(n, 10))
      .filter((n) => !isNaN(n) && n >= 1 && n <= GENRES.length);

    for (const n of nums) {
      const genreId = GENRES[n - 1].id;
      if (excluded.has(genreId)) {
        excluded.delete(genreId); // toggle back on
      } else {
        excluded.add(genreId);
      }
    }
  }
  config.excludedGenres = [...excluded];

  if (excluded.size > 0) {
    const names = [...excluded]
      .map((id) => GENRES.find((g) => g.id === id)?.label ?? id)
      .join(", ");
    console.log(`\n  Excluded: ${names}`);
  } else {
    console.log("\n  All genres enabled!");
  }

  // ── 3b. Cache size per mood ──
  if (config.provider === "local") {
    console.log("\n  ── Variety vs warmup ──\n");
    console.log("  Each mood caches up to N instrumental tracks.");
    console.log("  Higher = more variety, but more local generation time during warmup.");
    console.log("  This also uses more disk space under ~/.vibe/cache.\n");
  } else {
    console.log("\n  ── Variety vs credits ──\n");
    console.log("  Each mood caches up to N instrumental tracks. Higher = more");
    console.log("  variety, but warmup burns more ElevenLabs credits.");
    console.log("  Rough warmup cost (8 moods × N × 3 min × 1,500 credits/min):");
    console.log("    1  →  36k credits   (~22% of Creator monthly, least variety)");
    console.log("    2  →  72k credits   (~45%)");
    console.log("    3  →  108k credits  (~67%, recommended)");
    console.log("    5  →  180k credits  (exceeds Creator — needs Pro)");
    console.log("  Vocals mode ignores this cap — every track is freshly generated.\n");
  }

  const cacheAnswer = await ask(`  Tracks per mood [${config.cacheSizePerMood}]: `);
  if (cacheAnswer) {
    const n = parseInt(cacheAnswer, 10);
    if (!isNaN(n) && n >= 1 && n <= 20) {
      config.cacheSizePerMood = n;
    }
  }

  // ── 3c. Cache-only mode ──
  console.log("\n  ── Cache-only mode ──\n");
  if (config.provider === "local") {
    console.log("  Never generate new local tracks; just rotate what's already");
    console.log("  cached in ~/.vibe/cache. Moods with no cached tracks yet");
    console.log("  will stay silent. Useful if local generation is too slow");
    console.log("  on your machine after initial warmup.\n");
  } else {
    console.log("  Zero-credit mode: never call ElevenLabs, just rotate the");
    console.log("  tracks already in ~/.vibe/cache. Moods with no cached tracks");
    console.log("  yet will stay silent. Good for after warmup, or if you've");
    console.log("  burned through your monthly credits.\n");
  }

  const currentCacheOnly = config.cacheOnlyMode ? "on" : "off";
  const cacheOnlyAnswer = (await ask(
    `  Cache-only mode? (on/off) [${currentCacheOnly}]: `
  )).toLowerCase();
  if (cacheOnlyAnswer === "on" || cacheOnlyAnswer === "y" || cacheOnlyAnswer === "yes") {
    config.cacheOnlyMode = true;
  } else if (cacheOnlyAnswer === "off" || cacheOnlyAnswer === "n" || cacheOnlyAnswer === "no") {
    config.cacheOnlyMode = false;
  }
  console.log(`  Mode: ${config.cacheOnlyMode ? "cache-only (no new generation)" : "normal (generate as needed)"}`);

  // ── 4. Interesting vibes ──
  console.log("\n  ── Vibe Mode ──\n");
  console.log("  Normal: clean genre picks (e.g. \"synthwave, steady rhythm\")");
  console.log("  Interesting: wild cross-genre mashups (e.g. \"didgeridoo");
  console.log("    ambient meets melodic death metal with jazz harmonies\")\n");

  const currentVibeMode = config.interestingVibes ? "interesting" : "normal";
  const vibeAnswer = await ask(
    `  Vibe mode? (normal/interesting) [${currentVibeMode}]: `
  );
  if (vibeAnswer.toLowerCase().startsWith("i")) {
    config.interestingVibes = true;
  } else if (vibeAnswer.toLowerCase().startsWith("n")) {
    config.interestingVibes = false;
  }
  console.log(
    `  Mode: ${config.interestingVibes ? "Interesting — buckle up" : "Normal"}`
  );

  // ── 5. Vocals ──
  if (config.provider === "local") {
    console.log("\n  ── Vocals ──\n");
    console.log("  Local backend is instrumental only — skipping vocals prompt.");
  } else {
    console.log("\n  ── Vocals ──\n");
    console.log("  Instrumental: pure background music (default)");
    console.log("  Vocals: Haiku writes lyrics about your code and the AI sings them\n");

    const currentVocals = config.vocals ? "vocals" : "instrumental";
    const vocalsAnswer = await ask(
      `  Vocals? (instrumental/vocals) [${currentVocals}]: `
    );
    if (vocalsAnswer.toLowerCase().startsWith("v")) {
      config.vocals = true;
    } else if (vocalsAnswer.toLowerCase().startsWith("i")) {
      config.vocals = false;
    }
    console.log(
      `  Mode: ${config.vocals ? "Vocals — Haiku writes the lyrics" : "Instrumental"}`
    );
  }

  // ── 6. Save config ──
  saveConfig(config);
  console.log(`\n  Config saved to ${join(getVibeDir(), "config.json")}`);

  // ── 7. Install hook scripts ──
  const hooksDir = join(getVibeDir(), "hooks");
  ensureVibeDir();
  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  const srcHooksDir = join(__dirname, "hooks");
  const requiredHooks = ["start-daemon.mjs", "stop-daemon.mjs", "send-event.mjs"];
  const isWindows = process.platform === "win32";
  const missingHooks: string[] = [];
  for (const file of requiredHooks) {
    const src = join(srcHooksDir, file);
    const dest = join(hooksDir, file);
    if (existsSync(src)) {
      copyFileSync(src, dest);
      if (!isWindows) chmodSync(dest, 0o755);
    } else {
      missingHooks.push(file);
    }
  }
  if (missingHooks.length > 0) {
    console.error(
      `\n  ERROR: Missing hook assets in ${srcHooksDir}: ${missingHooks.join(", ")}`
    );
    console.error("  Run `npm run build` and try again.");
    process.exit(1);
  }

  const statusSrc = join(__dirname, "status-line.mjs");
  const statusDest = join(hooksDir, "status-line.mjs");
  const hasStatusLine = existsSync(statusSrc);
  if (hasStatusLine) {
    copyFileSync(statusSrc, statusDest);
    if (!isWindows) chmodSync(statusDest, 0o755);
  } else {
    console.warn("  Warning: status-line.mjs missing — status line won't be configured.");
  }

  // Write daemon + uninstall paths so hooks / skill can find them
  const daemonPath = join(__dirname, "daemon.js");
  writeFileSync(join(getVibeDir(), "daemon-path"), daemonPath);
  const uninstallPath = join(__dirname, "uninstall.js");
  writeFileSync(join(getVibeDir(), "uninstall-path"), uninstallPath);

  console.log(`  Hook scripts installed to ${hooksDir}`);

  // ── 7b. Install skills ──
  // Only the user-invocable `vibe` skill lives in ~/.claude/skills/. Backend
  // rules are shipped as plain markdown under ~/.vibe/skill-guidance/ and
  // read on demand by the `vibe` skill — see the comment at the top of each
  // guidance file for why they aren't sub-skills.
  const skillsSrcDir = join(__dirname, "skills");
  if (existsSync(skillsSrcDir)) {
    const claudeSkillsDir = join(homedir(), ".claude", "skills");
    if (!existsSync(claudeSkillsDir)) {
      mkdirSync(claudeSkillsDir, { recursive: true });
    }
    const installedSkills: string[] = [];
    for (const entry of readdirSync(skillsSrcDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillSrcPath = join(skillsSrcDir, entry.name, "SKILL.md");
      if (!existsSync(skillSrcPath)) continue;
      const skillDir = join(claudeSkillsDir, entry.name);
      if (!existsSync(skillDir)) {
        mkdirSync(skillDir, { recursive: true });
      }
      copyFileSync(skillSrcPath, join(skillDir, "SKILL.md"));
      installedSkills.push(entry.name);
    }
    if (installedSkills.length > 0) {
      console.log(`  Installed skills: ${installedSkills.join(", ")}`);
    }
  }

  // ── 7c. Install backend guidance files ──
  // Plain-markdown helpers the `vibe` skill reads on demand, keyed by
  // config.provider. Not Claude Code skills — see the comment block at the
  // top of each file for rationale.
  const guidanceSrcDir = join(__dirname, "skill-guidance");
  if (existsSync(guidanceSrcDir)) {
    const guidanceDestDir = join(getVibeDir(), "skill-guidance");
    if (!existsSync(guidanceDestDir)) {
      mkdirSync(guidanceDestDir, { recursive: true });
    }
    const installedGuidance: string[] = [];
    for (const entry of readdirSync(guidanceSrcDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      copyFileSync(
        join(guidanceSrcDir, entry.name),
        join(guidanceDestDir, entry.name)
      );
      installedGuidance.push(entry.name);
    }
    if (installedGuidance.length > 0) {
      console.log(
        `  Installed skill guidance: ${installedGuidance.join(", ")}`
      );
    }
  }

  // ── 8. Patch Claude Code settings ──
  const claudeSettingsPath = join(homedir(), ".claude", "settings.json");
  const shouldPatch = await ask(
    `\n  Add hooks to ${claudeSettingsPath}? [Y/n]: `
  );

  if (shouldPatch.toLowerCase() !== "n") {
    patchClaudeSettings(claudeSettingsPath, hooksDir, hasStatusLine);
    console.log("  Claude Code settings updated!");
  } else {
    console.log("  Skipped. You'll need to add hooks manually.");
    printManualConfig(hooksDir);
  }

  // ── Done ──
  console.log("\n  ╔══════════════════════════════════════╗");
  console.log("  ║  Setup complete! Start a new Claude  ║");
  console.log("  ║  Code session to hear the vibes.     ║");
  console.log("  ╚══════════════════════════════════════╝\n");

  printSummary(config);
  rl.close();
}

async function runLocalBackendSetup(
  config: ReturnType<typeof loadConfig>
): Promise<boolean> {
  console.log("  ── Local backend ──\n");

  const os = platform();
  let hwSummary: string;
  let nvidiaDetected = false;
  let driverCudaHint: string | null = null;
  let vramGb: number | undefined;
  let unifiedMemoryGb: number | undefined;
  let hwBackend: HardwareProfile["backend"] = "cpu";

  if (os === "darwin") {
    if (arch() !== "arm64") {
      console.log(
        "  Intel macOS detected — local generation is not supported here. Use ElevenLabs instead.\n"
      );
      return false;
    }
    hwBackend = "mps";
    unifiedMemoryGb = detectAppleSiliconMemory();
    hwSummary = `Apple Silicon macOS detected — will use MPS. ${unifiedMemoryGb ?? "?"} GB unified memory.`;
  } else if (os === "linux" || os === "win32") {
    const smiList = spawnSync("nvidia-smi", ["-L"], { stdio: "pipe" });
    const hasGpu =
      smiList.status === 0 &&
      /GPU \d+:/.test(smiList.stdout?.toString() ?? "");
    if (hasGpu) {
      nvidiaDetected = true;
      hwBackend = "cuda";
      const firstLine =
        smiList.stdout.toString().trim().split("\n")[0] ?? "Nvidia GPU";
      const smiHeader = spawnSync("nvidia-smi", [], { stdio: "pipe" });
      const headerOut = smiHeader.stdout?.toString() ?? "";
      const m = headerOut.match(/CUDA Version:\s*(\d+\.\d+)/);
      driverCudaHint = m ? m[1] : null;
      vramGb = detectNvidiaVram();
      hwSummary = driverCudaHint
        ? `Nvidia GPU detected: ${firstLine} (driver supports CUDA ≤ ${driverCudaHint}, ${vramGb ?? "?"} GB VRAM)`
        : `Nvidia GPU detected: ${firstLine} (${vramGb ?? "?"} GB VRAM)`;
    } else {
      hwSummary =
        "No Nvidia GPU detected — install will fall back to CPU torch wheels (very slow).";
    }
  } else {
    hwSummary = `Unsupported platform: ${os}. Local backend may not work.`;
  }
  console.log(`  ${hwSummary}\n`);

  const recommendation = recommendLocalMusicModel({
    platform: os as HardwareProfile["platform"],
    backend: hwBackend,
    vramGb,
    unifiedMemoryGb,
  });
  const recommendedAceStep = recommendation.aceStep ?? DEFAULT_ACE_STEP_CONFIG;

  console.log(`  Recommended model: ${formatRecommendation(recommendation)}`);
  console.log(`  Reason: ${recommendation.reason}\n`);

  let selectedBackend: LocalBackend = recommendation.localBackend;
  let size: LocalModelSize = recommendation.musicgenSize ?? config.local?.size ?? "medium";

  const backendOverride = (
    await ask(`  Backend? (ace-step/musicgen) [${selectedBackend}]: `)
  ).toLowerCase();
  if (backendOverride === "musicgen" || backendOverride === "m") {
    selectedBackend = "musicgen";
  } else if (backendOverride === "ace-step" || backendOverride === "a" || backendOverride === "ace") {
    selectedBackend = "ace-step";
  }

  if (selectedBackend === "musicgen") {
    console.log("\n  MusicGen model size:");
    console.log("    small   ~1.5 GB,  fastest, lowest quality");
    console.log("    medium  ~3.3 GB,  good balance  ← recommended");
    console.log("    large   ~13 GB,   highest quality, slowest, big VRAM\n");

    const currentSize = config.local?.size ?? "medium";
    const sizeAnswer = (
      await ask(`  Size? (small/medium/large) [${currentSize}]: `)
    ).toLowerCase();
    if (sizeAnswer === "small" || sizeAnswer === "s") size = "small";
    else if (sizeAnswer === "medium" || sizeAnswer === "m") size = "medium";
    else if (sizeAnswer === "large" || sizeAnswer === "l") size = "large";
    console.log(`  Size: ${size}\n`);
  } else {
    console.log(
      `\n  ACE-Step config: ${formatAceStepConfig(recommendedAceStep)}\n`
    );
  }

  let cudaArg: string | null = null;
  if (nvidiaDetected) {
    console.log("  CUDA toolkit:");
    console.log("    PyTorch's default PyPI wheel bundles a recent CUDA 12.x");
    console.log("    runtime and works on any system with a CUDA 12+ driver.");
    console.log("    Only pin a version if you specifically need a CTK match");
    console.log("    (e.g. building custom extensions).");
    if (driverCudaHint) {
      console.log(`    Your driver's max CUDA: ${driverCudaHint}`);
    }
    console.log("    Examples: 12.4, 12.6, 12.8, 13.0\n");
    const cudaAnswer = (
      await ask("  CUDA toolkit version (blank = PyTorch default): ")
    ).trim();
    if (cudaAnswer) {
      if (!/^\d+\.\d+$/.test(cudaAnswer)) {
        console.log(
          `  Couldn't parse "${cudaAnswer}" as major.minor — using PyTorch default instead.`
        );
      } else {
        cudaArg = cudaAnswer;
      }
    }
    console.log(
      `  CUDA: ${cudaArg ?? "PyTorch default (cu12.x from PyPI)"}\n`
    );
  }

  const proceed = (
    await ask(
      "  Run installer now? Checks ffmpeg, downloads uv, creates a venv, installs torch + dependencies. (Y/n): "
    )
  ).toLowerCase();
  if (proceed === "n" || proceed === "no") {
    console.log("  Skipped. Run `npm run setup:local` later to finish setup.\n");
    return config.local !== null;
  }

  const installArgs = [
    join(__dirname, "..", "scripts", "install-local.mjs"),
    "--backend",
    selectedBackend,
    "--size",
    size,
  ];
  if (selectedBackend === "ace-step") {
    installArgs.push("--dit-model", recommendedAceStep.ditModel);
    if (recommendedAceStep.lmModel) {
      installArgs.push("--lm-model", recommendedAceStep.lmModel);
    }
  }
  if (cudaArg) {
    installArgs.push("--cuda", cudaArg);
  }
  const result = spawnSync(process.execPath, installArgs, {
    stdio: "inherit",
    cwd: join(__dirname, ".."),
  });
  if (result.status !== 0) {
    console.error(
      "\n  Local backend installer failed. Fix the error above and re-run `npm run setup:local`.\n"
    );
    return config.local !== null;
  }

  const reloaded = loadConfig();
  config.provider = reloaded.provider;
  config.local = reloaded.local;
  config.vocals = reloaded.vocals;
  return config.local !== null;
}

function detectAppleSiliconMemory(): number | undefined {
  const r = spawnSync("sysctl", ["-n", "hw.memsize"], { stdio: "pipe" });
  if (r.status !== 0) return undefined;
  const bytes = parseInt(r.stdout.toString().trim(), 10);
  if (isNaN(bytes)) return undefined;
  return Math.round(bytes / (1024 * 1024 * 1024));
}

function detectNvidiaVram(): number | undefined {
  const r = spawnSync(
    "nvidia-smi",
    ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
    { stdio: "pipe" },
  );
  if (r.status !== 0) return undefined;
  const mb = parseInt(r.stdout.toString().trim().split("\n")[0], 10);
  if (isNaN(mb)) return undefined;
  return Math.round(mb / 1024);
}

function formatRecommendation(rec: ReturnType<typeof recommendLocalMusicModel>): string {
  if (rec.localBackend === "musicgen") {
    return `MusicGen ${rec.musicgenSize ?? "medium"}`;
  }
  return formatAceStepConfig(rec.aceStep ?? DEFAULT_ACE_STEP_CONFIG);
}

function formatAceStepConfig(aceStep: typeof DEFAULT_ACE_STEP_CONFIG): string {
  const dit = aceStep.ditModel;
  const lm = aceStep.lmModel;
  return lm ? `${dit} + ${lm}` : `${dit} (DiT only)`;
}

function printSummary(config: ReturnType<typeof loadConfig>): void {
  console.log("  Your config:");
  const localLabel = config.local
    ? config.local.backend === "ace-step" && config.local.aceStep
      ? ` (${config.local.aceStep.ditModel}${config.local.aceStep.lmModel ? " + " + config.local.aceStep.lmModel : ""})`
      : ` (musicgen-${config.local.size})`
    : "";
  console.log(`    Backend:     ${config.provider}${localLabel}`);
  console.log(`    Volume:      ${config.volume}`);
  console.log(
    `    Cache/mood:  ${config.cacheSizePerMood} track(s)${config.provider === "local" ? " for local warmup/rotation" : ""}`
  );
  console.log(
    `    Genres:      ${config.excludedGenres.length > 0 ? `${GENRES.length - config.excludedGenres.length}/${GENRES.length} enabled` : "all enabled"}`
  );
  console.log(
    `    Vibe mode:   ${config.interestingVibes ? "interesting (cross-genre mashups)" : "normal"}`
  );
  console.log(
    `    Vocals:      ${config.vocals ? "on (Haiku writes lyrics about your code)" : "off (instrumental)"}`
  );
  console.log(
    `    Cache-only:  ${
      config.cacheOnlyMode
        ? config.provider === "local"
          ? "on (reuse local cache only)"
          : "on (no new generation — zero credits)"
        : config.provider === "local"
          ? "off (generate locally as needed)"
          : "off (generate as needed)"
    }`
  );
  console.log("");
}

function nodeCommand(scriptPath: string): string {
  // Wrap with quotes so paths with spaces work under sh and cmd.exe alike.
  return `"${process.execPath}" "${scriptPath}"`;
}

function patchClaudeSettings(
  settingsPath: string,
  hooksDir: string,
  includeStatusLine: boolean
): void {
  let settings: Record<string, unknown> = {};

  const claudeDir = dirname(settingsPath);
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      // Start fresh
    }
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;

  const sendEventHook = {
    matcher: "",
    hooks: [
      {
        type: "command",
        command: nodeCommand(join(hooksDir, "send-event.mjs")),
        async: true,
        statusMessage: "vibe: reading the room...",
      },
    ],
  };

  hooks.SessionStart = appendHook(hooks.SessionStart, {
    matcher: "",
    hooks: [
      {
        type: "command",
        command: nodeCommand(join(hooksDir, "start-daemon.mjs")),
        async: true,
        statusMessage: "vibe: starting the music...",
      },
    ],
  });

  hooks.SessionEnd = appendHook(hooks.SessionEnd, {
    matcher: "",
    hooks: [
      {
        type: "command",
        command: nodeCommand(join(hooksDir, "stop-daemon.mjs")),
        async: true,
        statusMessage: "vibe: fading out...",
      },
    ],
  });

  hooks.PostToolUse = appendHook(hooks.PostToolUse, sendEventHook);
  hooks.UserPromptSubmit = appendHook(hooks.UserPromptSubmit, sendEventHook);
  hooks.Stop = appendHook(hooks.Stop, sendEventHook);

  settings.hooks = hooks;
  if (includeStatusLine) {
    // Preserve any existing non-vibe statusLine so we don't silently
    // clobber the user's custom setup. We only write ours if the slot is
    // empty OR already points at a vibe status-line script (re-running
    // setup / upgrading paths).
    const existing = (settings.statusLine ?? null) as
      | { command?: string }
      | null;
    const existingCmd = typeof existing?.command === "string" ? existing.command : "";
    const isOurs =
      existingCmd.includes("status-line.mjs") &&
      (existingCmd.includes(".vibe/hooks/") ||
        existingCmd.includes(".vibe\\hooks\\"));
    if (!existing || isOurs) {
      settings.statusLine = {
        type: "command",
        command: nodeCommand(join(hooksDir, "status-line.mjs")),
      };
    } else {
      console.log(
        "  Note: existing statusLine detected — leaving it alone. To use the vibe status line, remove it from ~/.claude/settings.json and re-run setup."
      );
    }
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

// Match any hook whose command references one of the vibe hook scripts. We
// dedupe on the *script path*, not the whole entry — so re-running setup
// after the user tweaked `statusMessage`, moved the install, or after we
// changed any other field in a future version still replaces cleanly
// instead of appending a second copy.
function isVibeHookEntry(h: any, scriptBasename: string): boolean {
  const hooksArr = Array.isArray(h?.hooks) ? h.hooks : [];
  return hooksArr.some((cmd: any) => {
    const c = String(cmd?.command ?? "");
    const refsVibeDir =
      c.includes(".vibe/hooks/") || c.includes(".vibe\\hooks\\");
    return refsVibeDir && c.includes(scriptBasename);
  });
}

function hookScriptBasename(newHook: any): string | null {
  const cmd = newHook?.hooks?.[0]?.command;
  if (typeof cmd !== "string") return null;
  const match = cmd.match(/([a-zA-Z0-9_-]+\.mjs)/);
  return match ? match[1] : null;
}

function appendHook(existing: unknown, newHook: unknown): unknown[] {
  const basename = hookScriptBasename(newHook);
  if (Array.isArray(existing)) {
    if (basename) {
      // Drop any prior entry that references the same script, then append
      // the fresh version. Idempotent across re-runs and field tweaks.
      const filtered = existing.filter((h) => !isVibeHookEntry(h, basename));
      return [...filtered, newHook];
    }
    // Fallback to the old stringify-equality path if we can't extract a
    // basename (shouldn't happen for any hook we construct here).
    const alreadyExists = existing.some(
      (h: any) => JSON.stringify(h) === JSON.stringify(newHook)
    );
    return alreadyExists ? existing : [...existing, newHook];
  }
  return [newHook];
}

function printManualConfig(hooksDir: string): void {
  console.log("\n  Add this to ~/.claude/settings.json:\n");
  console.log(
    JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              matcher: "",
              hooks: [
                { type: "command", command: nodeCommand(join(hooksDir, "start-daemon.mjs")), async: true },
              ],
            },
          ],
          PostToolUse: [
            {
              matcher: "",
              hooks: [
                { type: "command", command: nodeCommand(join(hooksDir, "send-event.mjs")), async: true },
              ],
            },
          ],
        },
        statusLine: { command: nodeCommand(join(hooksDir, "status-line.mjs")) },
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
