#!/usr/bin/env node
// Hook: SessionEnd — notifies the daemon that this session has ended.
// The daemon shuts itself down once all sessions have ended.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PORT_FILE = join(homedir(), ".vibe", "daemon.port");

if (!existsSync(PORT_FILE)) {
  process.exit(0);
}

let port;
try {
  port = parseInt(readFileSync(PORT_FILE, "utf-8").trim(), 10);
} catch {
  process.exit(0);
}
if (!Number.isFinite(port)) process.exit(0);

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
  // Best effort.
} finally {
  clearTimeout(timer);
}
