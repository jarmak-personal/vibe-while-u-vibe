---
name: vibe-local
description: Local MusicGen-specific guidance for vibe-while-u-vibe. Use only when ~/.vibe/config.json has provider=local, especially for vocals, generation latency, worker errors, setup:local, and local cache behavior.
user-invocable: false
---

# vibe-local

This skill applies only when `~/.vibe/config.json` has `provider: "local"`.

## Rules

- Local mode is instrumental-only. Reject vocals-on requests in one line.
- Local mode uses the Python MusicGen worker, so generation can take noticeably longer than ElevenLabs.
- Startup lag after switching to local is acceptable; the daemon may be up before the worker is fully warm.
- If the user sees worker/setup failures, point them to `npm run setup:local`.
- If generation is failing because the worker or venv is missing, say that plainly instead of pretending the daemon can recover instantly.

## User-facing guidance

- `turn vocals on`:
  `Local mode is instrumental-only; vocals are unavailable.`
- `why is it slow?`:
  explain that MusicGen runs locally and may take tens of seconds or more depending on hardware/model size.
- `how do I set up local?`:
  point them to `npm run setup` and choose local, or `npm run setup:local`.
- `worker died / local failed`:
  tell them to restart the daemon by ending and starting a Claude Code session after fixing setup.

## Track location

Local generations still land in the normal cache:
- `~/.vibe/cache/instrumental/<mood>/*.mp3`

There are no vocal tracks in local mode.
