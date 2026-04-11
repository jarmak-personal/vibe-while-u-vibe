#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { getVibeDir } from "./config.js";
import { getDaemonHealth } from "./state.js";

const autoYes = process.argv.includes("--yes") || process.argv.includes("-y");
const keepCacheFlag = process.argv.includes("--keep-cache");

const rl = autoYes
  ? null
  : createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
  if (!rl) return Promise.resolve("y");
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function main(): Promise<void> {
  console.log("\n  vibe-while-u-vibe uninstall\n");

  let keepCache = keepCacheFlag;

  if (!autoYes) {
    const confirm = await ask("  Remove vibe hooks and config? [y/N]: ");
    if (confirm.toLowerCase() !== "y") {
      console.log("  Cancelled.\n");
      rl?.close();
      return;
    }
    if (!keepCache) {
      const answer = await ask("  Keep cached tracks in ~/.vibe/cache? [y/N]: ");
      keepCache = answer.toLowerCase() === "y";
    }
  }

  // 1. Kill running daemon and wait for it to actually exit.
  // Without the wait, rmSync below can race the daemon's shutdown writes
  // (daemon.log, cache dirs) and throw ENOTEMPTY on macOS/Linux.
  // Use the PID reported by the /health endpoint — never trust the pid
  // file alone, because PIDs get recycled and we don't want to SIGTERM
  // some unrelated process that happens to inherit the same PID.
  const health = await getDaemonHealth();
  if (health) {
    const pid = health.pid;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone
    }
    // Poll for process exit (up to 3s)
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        break; // process is gone
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    // Escalate to SIGKILL if still alive
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
      await new Promise((r) => setTimeout(r, 200));
    } catch {
      // Already gone
    }
    console.log(`  Stopped daemon (PID ${pid})`);
  }

  // 2. Remove hooks from ~/.claude/settings.json
  const claudeSettingsPath = join(homedir(), ".claude", "settings.json");
  if (existsSync(claudeSettingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(claudeSettingsPath, "utf-8"));
      let changed = false;

      // Match both POSIX and Windows paths under ~/.vibe/hooks/
      const isVibeHook = (serialized: string): boolean =>
        serialized.includes(".vibe/hooks/") ||
        serialized.includes(".vibe\\\\hooks\\\\");

      // Remove vibe hooks
      if (settings.hooks) {
        for (const [event, hookList] of Object.entries(settings.hooks)) {
          if (Array.isArray(hookList)) {
            const filtered = hookList.filter(
              (h: any) => !isVibeHook(JSON.stringify(h))
            );
            if (filtered.length !== hookList.length) {
              changed = true;
              if (filtered.length === 0) {
                delete settings.hooks[event];
              } else {
                settings.hooks[event] = filtered;
              }
            }
          }
        }
        if (Object.keys(settings.hooks).length === 0) {
          delete settings.hooks;
        }
      }

      // Remove statusLine if it's ours
      if (
        settings.statusLine?.command &&
        isVibeHook(String(settings.statusLine.command))
      ) {
        delete settings.statusLine;
        changed = true;
      }

      if (changed) {
        writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2) + "\n");
        console.log("  Removed hooks from ~/.claude/settings.json");
      } else {
        console.log("  No vibe hooks found in settings.json");
      }
    } catch (err) {
      console.error("  Warning: could not clean settings.json:", err);
    }
  }

  // 3. Remove ~/.vibe directory (or everything except cache/ if keeping)
  const vibeDir = getVibeDir();
  if (existsSync(vibeDir)) {
    if (keepCache) {
      for (const entry of readdirSync(vibeDir)) {
        if (entry === "cache") continue;
        rmSync(join(vibeDir, entry), { recursive: true, force: true });
      }
      console.log("  Removed ~/.vibe contents (kept cache/)");
    } else {
      rmSync(vibeDir, { recursive: true, force: true });
      console.log("  Removed ~/.vibe (config, cache, hooks)");
    }
  }

  // 4. Remove installed vibe skills.
  // Only `vibe` lives under ~/.claude/skills/ — the old hidden backend
  // sub-skills (`vibe-local`, `vibe-elevenlabs`) were moved to plain
  // markdown under ~/.vibe/skill-guidance/ so they wouldn't eat session
  // context, and get removed as part of the ~/.vibe cleanup above. We still
  // sweep the old names here so users upgrading from a previous install
  // don't end up with orphan skill directories that Claude Code would keep
  // advertising forever.
  const skillRoot = join(homedir(), ".claude", "skills");
  const skillNames = ["vibe", "vibe-local", "vibe-elevenlabs"];
  const removedSkills: string[] = [];
  for (const name of skillNames) {
    const skillDir = join(skillRoot, name);
    if (!existsSync(skillDir)) continue;
    rmSync(skillDir, { recursive: true, force: true });
    removedSkills.push(name);
  }
  if (removedSkills.length > 0) {
    console.log(`  Removed skills: ${removedSkills.join(", ")}`);
  }

  console.log("\n  Uninstalled. Your Claude Code sessions will no longer play music.\n");
  rl?.close();
}

main().catch((err) => {
  console.error("Uninstall failed:", err);
  process.exit(1);
});
