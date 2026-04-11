#!/usr/bin/env node
// Hook: PostToolUse / UserPromptSubmit / Stop — forwards the event JSON to
// the running daemon. Non-blocking: failures are swallowed.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PORT_FILE = join(homedir(), ".vibe", "daemon.port");

// The SessionStart hook spawns the daemon detached, but the daemon only
// writes daemon.port from inside its server.listen() callback. Hooks that
// fire right after SessionStart (PostToolUse on the first tool call,
// UserPromptSubmit on the first prompt) routinely race the daemon's port
// write and would otherwise drop the first events of a fresh session.
// Wait briefly for the port file to appear. If the daemon isn't coming up
// at all (no-op path), this caps total overhead at ~1s.
async function waitForPortFile(maxMs = 1000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (existsSync(PORT_FILE)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return existsSync(PORT_FILE);
}

if (!(await waitForPortFile())) {
  process.exit(0);
}

let port;
try {
  port = parseInt(readFileSync(PORT_FILE, "utf-8").trim(), 10);
} catch {
  process.exit(0);
}
if (!Number.isFinite(port)) process.exit(0);

// Read full stdin (hook JSON)
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const body = Buffer.concat(chunks).toString("utf-8");

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 2000);

try {
  await fetch(`http://127.0.0.1:${port}/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: controller.signal,
  });
} catch {
  // Best effort — daemon may be down or slow. Never block Claude Code.
} finally {
  clearTimeout(timer);
}
