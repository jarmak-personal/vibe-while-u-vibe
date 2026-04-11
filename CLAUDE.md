# vibe-while-u-vibe

Claude Code plugin that auto-generates thematic AI music during coding sessions.

## Build & Run

```bash
npm install
npm run build        # compile TypeScript
npm start            # run the daemon
npm run setup        # interactive setup CLI
npm run test:smoke   # local-only smoke tests (see below)
```

## Tests

Two tiers of smoke tests live under `scripts/`:

**Local only** (`npm run test:smoke`) — exercises the real `claude` CLI:
- `smoke-headless.mjs` — runs `classifyVibe` + `generateSessionLyrics` against a fake event buffer and prints the result.
- `smoke-wiring.mjs` — swaps `dist/elevenlabs.js` for a mock, routes a real `Playlist.switchMood` through the classifier, and asserts the lyrics string reaches `generateTrack` unchanged.

**CI** (`npm run test:ci`, wired into `.github/workflows/build.yml`) — fully mocked:
- `smoke-ci.mjs` — swaps BOTH `dist/claude-headless.js` and `dist/elevenlabs.js` for stubs, then verifies the full classifier → playlist → generateTrack pipeline with canned mood/lyrics. Catches regressions in the wiring even though GHA runners have no `claude` CLI.

All three restore the swapped modules in `finally`. The local tests call the real LLM and ElevenLabs quota check; CI does not.

## Architecture

- `src/daemon.ts` — HTTP server on localhost:7773, main orchestrator
- `src/config.ts` — loads ~/.vibe/config.json
- `src/state.ts` — shared state + JSON persistence to ~/.vibe/state.json
- `src/player.ts` — macOS afplay wrapper
- `src/elevenlabs.ts` — ElevenLabs Eleven Music API client
- `src/vibe-classifier.ts` — LLM-powered mood classification via Haiku
- `src/playlist.ts` — track cache, queue, and loop management
- `src/moods.ts` — mood definitions + music style prompts
- `src/hooks/` — Node scripts (.mjs) for CC hook integration
- `src/status-line.mjs` — CC status line display script
- `src/setup.ts` — interactive setup CLI

## Key Design Points

- Daemon communicates with CC via async HTTP hooks (non-blocking)
- Vibe classification uses Haiku (~100 input tokens per call, debounced)
- Cached tracks per mood capped at `config.cacheSizePerMood` (default 3); vocals mode bypasses cache
- Audio playback via macOS `afplay` (volume default 0.3)
- State persisted to `~/.vibe/state.json` for status line to read
