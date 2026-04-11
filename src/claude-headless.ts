import { spawn } from "node:child_process";

// Runs `claude --print` in one-shot mode. stdin is explicitly ignored —
// execFile's default pipe leaves stdin open, which makes `claude --print`
// hang for 3s waiting on stdin data and then fail even though the positional
// prompt was provided.
//
// This lives in its own file so smoke tests can swap it for a mock
// implementation at the compiled-dist layer, same trick we use for
// elevenlabs.js in scripts/smoke-wiring.mjs.
export function claudeHeadless(
  prompt: string,
  systemPrompt: string,
  model: "haiku" | "sonnet" = "haiku",
  timeoutMs = 30000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "--print",
      "--model", model,
      "--max-turns", "1",
      "--system-prompt", systemPrompt,
      prompt,
    ];

    const proc = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`claude --print timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`claude --print spawn failed: ${err.message}`));
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude --print exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}
