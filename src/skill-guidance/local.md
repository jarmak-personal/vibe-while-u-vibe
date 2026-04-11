<!--
  Backend-specific guidance for the `vibe` skill when config.provider === "local".

  This file is NOT a Claude Code skill. It's plain markdown that the `vibe`
  skill Reads on demand after it inspects ~/.vibe/config.json. We used to ship
  this as a hidden sub-skill (user-invocable: false), but Claude Code still
  keeps every skill's `description` frontmatter in session context so the model
  can decide whether to load it — which meant both backends' frontmatter were
  always loaded, for every session, even though only one provider is ever
  active at a time. Moving the rules out of the skill directory drops that
  per-session token cost while keeping the dispatch logic in one place (the
  `vibe` skill itself).

  Installed to ~/.vibe/skill-guidance/local.md by setup/start-daemon.
-->

# vibe — local backend guidance

Applies only when `~/.vibe/config.json` has `provider: "local"`.

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
