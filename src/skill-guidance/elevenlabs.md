<!--
  Backend-specific guidance for the `vibe` skill when config.provider === "elevenlabs".

  This file is NOT a Claude Code skill. It's plain markdown that the `vibe`
  skill Reads on demand after it inspects ~/.vibe/config.json. We used to ship
  this as a hidden sub-skill (user-invocable: false), but Claude Code still
  keeps every skill's `description` frontmatter in session context so the model
  can decide whether to load it — which meant both backends' frontmatter were
  always loaded, for every session, even though only one provider is ever
  active at a time. Moving the rules out of the skill directory drops that
  per-session token cost while keeping the dispatch logic in one place (the
  `vibe` skill itself).

  Installed to ~/.vibe/skill-guidance/elevenlabs.md by setup/start-daemon.
-->

# vibe — ElevenLabs backend guidance

Applies only when `~/.vibe/config.json` has `provider: "elevenlabs"`.

## Rules

- Vocals are supported in this mode.
- Missing API key errors should direct the user to `npm run setup` or `ELEVENLABS_API_KEY`.
- Credit exhaustion should be explained plainly: cached tracks may still play, but no new cloud generation will happen.
- ElevenLabs tracks are cloud-generated, so they are usually faster to start than local MusicGen once the daemon is running.

## User-facing guidance

- `turn vocals on`:
  allowed.
- `why isn't it generating?` with missing key:
  tell them to run `npm run setup` or export `ELEVENLABS_API_KEY`.
- `out of credits`:
  explain that cached tracks can continue, but new tracks require more ElevenLabs credits.

## Track location

ElevenLabs tracks are still cached locally:
- instrumental: `~/.vibe/cache/instrumental/<mood>/*.mp3`
- vocals: `~/.vibe/cache/vocals/<mood>/*.mp3`
