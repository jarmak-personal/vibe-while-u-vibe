# vibe-while-u-vibe

Claude Code plugin that auto-generates thematic AI music during coding sessions.

## Build & Run

```bash
npm install
npm run build        # compile TypeScript
npm start            # run the daemon
npm run setup        # interactive setup CLI (asks: cloud or local backend?)
npm run setup:local  # local backend only — installs uv, venv, torch, audiocraft
npm run test:smoke   # local-only smoke tests (see below)
```

## Backends

The daemon picks one of two music generators at boot via `config.provider`:

- **`elevenlabs`** (default) — cloud, paid, supports vocals. Needs an API key.
  Burns ~1,500 credits/min; Creator tier (~$22/mo) = ~35 tracks.
- **`local`** — Meta's MusicGen via [audiocraft](https://github.com/facebookresearch/audiocraft).
  Free, runs on the user's machine, **instrumental only** (vocals are forced
  off in `loadConfig()` whenever `provider === "local"`). Needs Apple Silicon
  (MPS) or an Nvidia GPU + CUDA 12 for usable speed; CPU works but is too
  slow for daily use (multiple minutes per 30s clip).

Local setup (`npm run setup:local`):

1. Bootstraps `uv` if missing (PowerShell installer on Windows, sh installer
   on macOS/Linux).
2. Creates a Python 3.11 venv at `~/.vibe/venv`.
3. Installs torch + torchaudio from the right wheel index:
   - macOS → default PyPI (MPS support is in the standard wheel)
   - Linux/Windows + Nvidia → default PyPI by default (bundles a recent
     CUDA 12.x runtime, forward-compat with CUDA 13 drivers). Users can
     pin a specific CTK with `--cuda 12.4` etc., which routes to the
     matching `cu{major}{minor}` wheel index.
   - Linux/Windows, no GPU → `https://download.pytorch.org/whl/cpu`
4. Installs `audiocraft==1.3.0` from `python/requirements.txt`.
5. Writes `provider="local"` and the `local` config block (pythonPath,
   modelCacheDir, size, device, workerPort) into `~/.vibe/config.json`.

Model sizes (`facebook/musicgen-{size}`): `small` ~1.5 GB, `medium` ~3.3 GB
(recommended), `large` ~13 GB. Models cache to `~/.vibe/models` via
`HF_HOME` so `npm run uninstall` can clean them up.

At runtime the daemon spawns `python/worker.py` as a child process. The
worker hosts the model, prints `VIBE_WORKER_READY` on stdout when loaded,
and serves `POST /generate` over loopback with an `X-Vibe-Token` shared
secret. If the worker dies the next `generateTrack` throws
`GeneratorUnavailableError` and the daemon enters degraded mode — recovery
requires a daemon restart (no auto-respawn, by design, so users see a clear
error instead of silent cycling).

## Tests

Two tiers of smoke tests live under `scripts/`:

**Local only** (`npm run test:smoke`) — exercises the real `claude` CLI:
- `smoke-headless.mjs` — runs `classifyVibe` + `generateSessionLyrics` against a fake event buffer and prints the result.
- `smoke-wiring.mjs` — injects a mock `MusicGenerator` into `Playlist`, routes a real `Playlist.switchMood` through the classifier, and asserts the lyrics string reaches `generateTrack` unchanged.

**CI** (`npm run test:ci`, wired into `.github/workflows/build.yml`) — fully mocked:
- `smoke-ci.mjs` — swaps `dist/claude-headless.js` for a stub and injects an in-memory mock generator, then verifies the full classifier → playlist → generateTrack pipeline with canned mood/lyrics. Catches regressions in the wiring even though GHA runners have no `claude` CLI.

**Local backend** (`VIBE_TEST_LOCAL=1 npm run test:smoke:local`) — opt-in:
- `smoke-local.mjs` — spawns the real Python worker via `LocalGenerator`, generates one short clip, asserts it's a non-empty mp3, then shuts down. Skipped by default because it needs the venv + downloaded model weights.

All three restore swapped modules in `finally`. The local tests call the real LLM (where applicable); CI and `smoke-local` do not.

## Architecture

- `src/daemon.ts` — HTTP server on localhost:7773, main orchestrator
- `src/config.ts` — loads ~/.vibe/config.json (incl. `LocalConfig` block)
- `src/state.ts` — shared state + JSON persistence to ~/.vibe/state.json
- `src/player.ts` — cross-platform audio playback (afplay/ffplay/WMP)
- `src/cache.ts` — `~/.vibe/cache/{instrumental|vocals}/<mood>/` layout helpers
- `src/generators/types.ts` — `MusicGenerator` interface, `GenerateOptions`, error classes
- `src/generators/index.ts` — `createGenerator(config)` factory + `StubGenerator` for degraded mode
- `src/generators/elevenlabs.ts` — ElevenLabs Music API generator
- `src/generators/local.ts` — supervises the Python MusicGen worker over loopback HTTP
- `python/worker.py` — long-running HTTP server hosting `audiocraft.MusicGen`
- `src/vibe-classifier.ts` — LLM-powered mood classification via Haiku
- `src/playlist.ts` — track cache, queue, and loop management; takes a `MusicGenerator` via DI
- `src/moods.ts` — mood definitions + music style prompts
- `src/hooks/` — Node scripts (.mjs) for CC hook integration
- `src/status-line.mjs` — CC status line display script
- `src/setup.ts` — interactive setup CLI (branches on backend choice)
- `scripts/install-local.mjs` — uv + venv + torch + audiocraft bootstrap

## Key Design Points

- Daemon communicates with CC via async HTTP hooks (non-blocking)
- Vibe classification uses Haiku (~100 input tokens per call, debounced)
- Generator is dependency-injected into `Playlist`, so swapping providers (or mocking in tests) doesn't touch playlist logic
- Cached tracks per mood capped at `config.cacheSizePerMood` (default 3); vocals mode bypasses cache
- Local backend forces `vocals=false` in `loadConfig()` — single source of truth, can't be bypassed by hand-edits to config.json
- State persisted to `~/.vibe/state.json` for status line to read
- Degraded mode: if the generator can't init (missing key, dead worker, etc.) the daemon stays alive with a `StubGenerator` and surfaces the reason via `state.error`
