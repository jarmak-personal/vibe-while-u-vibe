---
name: vibe-elevenlabs
description: ElevenLabs-specific guidance for vibe-while-u-vibe. Use only when ~/.vibe/config.json has provider=elevenlabs, especially for vocals, API key issues, credit exhaustion, and cloud-generation behavior.
user-invocable: false
---

# vibe-elevenlabs

This skill applies only when `~/.vibe/config.json` has `provider: "elevenlabs"`.

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
