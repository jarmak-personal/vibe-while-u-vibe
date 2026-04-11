#!/usr/bin/env node

import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, ensureVibeDir, getVibeDir } from "./config.js";
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

  // ── 1. ElevenLabs API key ──
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
  console.log("\n  ── Variety vs credits ──\n");
  console.log("  Each mood caches up to N instrumental tracks. Higher = more");
  console.log("  variety, but warmup burns more ElevenLabs credits.");
  console.log("  Rough warmup cost (8 moods × N × 3 min × 1,500 credits/min):");
  console.log("    1  →  36k credits   (~22% of Creator monthly, least variety)");
  console.log("    2  →  72k credits   (~45%)");
  console.log("    3  →  108k credits  (~67%, recommended)");
  console.log("    5  →  180k credits  (exceeds Creator — needs Pro)");
  console.log("  Vocals mode ignores this cap — every track is freshly generated.\n");

  const cacheAnswer = await ask(`  Tracks per mood [${config.cacheSizePerMood}]: `);
  if (cacheAnswer) {
    const n = parseInt(cacheAnswer, 10);
    if (!isNaN(n) && n >= 1 && n <= 20) {
      config.cacheSizePerMood = n;
    }
  }

  // ── 3c. Cache-only mode ──
  console.log("\n  ── Cache-only mode ──\n");
  console.log("  Zero-credit mode: never call ElevenLabs, just rotate the");
  console.log("  tracks already in ~/.vibe/cache. Moods with no cached tracks");
  console.log("  yet will stay silent. Good for after warmup, or if you've");
  console.log("  burned through your monthly credits.\n");

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

  // ── 7b. Install /vibe skill ──
  const skillSrcPath = join(__dirname, "skills", "vibe", "SKILL.md");
  if (existsSync(skillSrcPath)) {
    const skillDir = join(homedir(), ".claude", "skills", "vibe");
    if (!existsSync(skillDir)) {
      mkdirSync(skillDir, { recursive: true });
    }
    copyFileSync(skillSrcPath, join(skillDir, "SKILL.md"));
    console.log(`  /vibe skill installed to ${skillDir}`);
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

function printSummary(config: ReturnType<typeof loadConfig>): void {
  console.log("  Your config:");
  console.log(`    Volume:      ${config.volume}`);
  console.log(`    Cache/mood:  ${config.cacheSizePerMood} track(s)`);
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
    `    Cache-only:  ${config.cacheOnlyMode ? "on (no new generation — zero credits)" : "off (generate as needed)"}`
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
