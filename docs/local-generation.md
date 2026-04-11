# Local music generation

> **Status:** shipped. This file started life as the design doc for the
> local-backend work and still reads like a plan — some details below
> describe the target state rather than the exact shipped implementation.
> The code is the source of truth; use this file for the *why*, not the
> *what*. Key divergences from the original plan are called out inline.

Adds a zero-cost, local-hardware generation backend as an alternative to the
ElevenLabs Music API. Targets Apple Silicon (MPS) and Nvidia GPUs (CUDA) on
macOS, Linux, and Windows. Locks vocals off — local models are instrumental
only.

## Goals

1. Users can pick a generation backend in setup: ElevenLabs (paid, with lyrics)
   or Local (free, instrumental).
2. Local backend works on macOS arm64, Linux + Nvidia, Windows + Nvidia.
3. User picks the model size (small/medium/large) based on their hardware.
4. Zero changes to the existing cache/playlist/mood behavior from the user's
   perspective — same file layout, same rotation, same prefetch.
5. Smoke tests continue to run on CI without a GPU or Python runtime.

## Non-goals

- Intel Mac support (no useful GPU path, CPU gen is minutes per track).
- AMD GPU support (ROCm adds a whole driver + wheel matrix we don't want).
- Lyrics in local mode (MusicGen/Stable Audio vocals quality is too poor).
- Hot-swapping the backend at runtime — requires daemon restart.
- Replacing ElevenLabs. It remains the default and the only path with custom
  per-session lyrics.

## High-level architecture

Today, `src/playlist.ts` imports `generateTrack`, `getCachedTracks`, and
`QuotaExceededError` directly from `./elevenlabs.js`. That hard coupling is
the first thing to break.

After the change:

```
                                              ┌──────────────────────┐
                                              │  ElevenLabsGenerator │
                                              └──────────┬───────────┘
                              ┌── MusicGenerator ────────┤
                              │     (interface)          │
                              │                          └──────────┐
┌───────────┐  injected   ┌───┴───────┐                   ┌─────────┴──────────┐
│ daemon.ts │────────────▶│ Playlist  │                   │   LocalGenerator   │
└───────────┘             └───────────┘                   │                    │
                                                          │   HTTP ───▶ worker │
                                                          │             (py)   │
                                                          └────────────────────┘
```

- `daemon.ts` reads `config.provider`, builds the right `MusicGenerator`,
  passes it into `new Playlist({ ..., generator })`.
- `playlist.ts` never imports a concrete backend.
- `src/cache.ts` owns `~/.vibe/cache/*` filesystem logic. Both generators use it.
- `src/generators/local.ts` spawns and supervises the Python worker, proxies
  generation requests via HTTP, manages restart-on-crash.
- `python/worker.py` is the long-running model-hosting process.

## Data model changes

### Config schema (`src/config.ts`)

```ts
export type Provider = "elevenlabs" | "local";
export type LocalModelSize = "small" | "medium" | "large";
export type LocalDevice = "mps" | "cuda" | "auto";

export interface LocalConfig {
  backend: "musicgen";        // reserved for future: "stable-audio-open"
  size: LocalModelSize;
  device: LocalDevice;        // "auto" resolves at worker startup
  workerPort: number;         // default 7774
  pythonPath: string;         // absolute path to venv python, set in setup
  modelCacheDir: string;      // default ~/.vibe/models
}

export interface VibeConfig {
  // ...existing fields
  provider: Provider;         // default "elevenlabs" for back-compat
  local: LocalConfig | null;  // null unless provider === "local"
}
```

Defaults for existing users: `provider: "elevenlabs"`, `local: null`. Merge in
`loadConfig` ensures an old config file still works unchanged.

Load-time invariant: when `provider === "local"`, forcibly set `vocals = false`
before returning. This covers any code path that reads config and bypasses the
setup CLI (e.g. hand-edited config.json).

### Cache layout (unchanged)

```
~/.vibe/cache/instrumental/<mood>/*.mp3   ← used by both providers
~/.vibe/cache/vocals/<mood>/*.mp3         ← ElevenLabs only, irrelevant in local
~/.vibe/models/musicgen-medium/           ← new, HuggingFace-style weights
~/.vibe/venv/                             ← new, uv-managed Python env
```

Moving the cache helpers out of `elevenlabs.ts` into `src/cache.ts` is a pure
refactor — no behavior change, just so both generators can `import { getCachedTracks } from "./cache.js"`.

## Interfaces & contracts

### `src/generators/types.ts` (new)

```ts
import type { Mood } from "../moods.js";

export interface GenerateOptions {
  mood: Mood;
  musicPrompt: string;
  lyrics?: string | null;     // ignored by LocalGenerator
  instrumental: boolean;      // LocalGenerator rejects `false`
}

export interface MusicGenerator {
  /** Returns absolute path to the generated mp3 file. */
  generateTrack(opts: GenerateOptions): Promise<string>;

  /** One-time init. Idempotent. */
  init(): Promise<void>;

  /** Tear down resources — called on daemon shutdown. */
  shutdown(): Promise<void>;

  /** Human-readable backend name for state/status-line display. */
  readonly name: string;
}

export class QuotaExceededError extends Error { /* ... */ }
export class GeneratorUnavailableError extends Error { /* ... */ }
```

`QuotaExceededError` moves here from `elevenlabs.ts`. The local generator
never throws it. `GeneratorUnavailableError` is new: thrown when the worker
can't start or crashes irrecoverably.

### Playlist constructor change

```ts
// Before
new Playlist({ volume, excludedGenres, ..., cacheOnlyMode });

// After
new Playlist({ volume, excludedGenres, ..., cacheOnlyMode, generator });
```

All `generateTrack(...)` calls inside `playlist.ts` become `this.generator.generateTrack(...)`. All `getCachedTracks(...)` imports move to `./cache.js`.
Error handling stays the same — `QuotaExceededError` is caught and sets
`quotaExceeded`. New: catch `GeneratorUnavailableError` and set a new
`generatorError` state field.

### Daemon wiring (`src/daemon.ts`)

```ts
import { createGenerator } from "./generators/index.js";

// ...after loadConfig()
const generator = await createGenerator(config);
// createGenerator handles API key validation for elevenlabs and worker
// spawn for local. On failure it throws GeneratorUnavailableError, which
// the daemon catches and surfaces via state.error without exiting.

const playlist = new Playlist({ /* ... */, generator });
```

The existing `initElevenLabs(apiKey)` + missingKey degraded-state logic
becomes part of `createGenerator`. Local backend has its own degraded path
(worker failed to spawn → surface "Run npm run setup:local" in state.error).

### Python worker protocol

HTTP on `127.0.0.1:${workerPort}`. Chosen over stdin-JSONL for three reasons:
(a) symmetric with the existing daemon HTTP model, (b) easier to debug with
`curl`, (c) simpler to add a `/health` probe for the startup gate.

```
GET  /health
     → 200 { "ready": true, "device": "mps", "model": "musicgen-medium" }
     → 503 { "ready": false, "reason": "loading model" }

POST /generate
     Body: { "prompt": "...", "duration_s": 180, "output_path": "/abs/path/to/out.mp3" }
     → 200 { "ok": true, "path": "/abs/path/to/out.mp3", "duration_ms": 58321 }
     → 500 { "ok": false, "error": "..." }

POST /shutdown
     → 200 { "ok": true }
     (worker exits cleanly after flushing)
```

- Worker writes the file to `output_path` directly — no streaming over HTTP,
  no base64 nonsense. The daemon picks a path under `~/.vibe/cache/instrumental/<mood>/`
  the same way the ElevenLabs client does (temp `.mp3.tmp`, rename on success).
- Exactly one `/generate` in flight. Worker returns 429 if a second request
  arrives — playlist already serializes via `withGenLock` so this is a safety
  net, not load-bearing.
- Startup: daemon spawns worker, polls `/health` every 500ms for up to 60s.
  If not ready in time → `GeneratorUnavailableError`.
- Supervision: **no auto-restart**. If the worker process dies, the next
  `generateTrack` throws `GeneratorUnavailableError` and the daemon enters
  degraded mode — `state.error` surfaces the reason in the status line and
  cached tracks keep looping. Recovery requires a daemon (i.e. Claude Code
  session) restart. This is deliberate: silent cycling hides real problems,
  and local worker crashes usually indicate env rot (missing venv, bad
  torch install) that a restart won't fix anyway.

### Worker startup signal

Rather than polling, we want the worker to announce readiness so the first
mood switch isn't gated on a timer. Two options, both OK:

1. Worker prints `VIBE_WORKER_READY\n` to stdout once the model is loaded.
   Daemon `readline`s stdout until it sees that line, then stops listening.
2. Worker writes a `~/.vibe/worker.pid.ready` file atomically.

Option 1 is simpler and doesn't leave files on crashes. Go with 1, fall back
to `/health` polling if stdout buffering causes issues on Windows.

## Setup flow

The setup CLI grows a backend selection step inserted as **step 0** (before
the ElevenLabs API key prompt):

```
── Generation backend ──

  (1) ElevenLabs     paid API, custom per-session lyrics
  (2) Local          free, runs on your GPU, instrumental only

  Backend [1]:
```

If user picks 2:

1. **Hardware detection.**
   - macOS arm64 → `device = mps`. Also check `sw_vers -productVersion` ≥ 12.3.
   - Linux/Windows → spawn `nvidia-smi -L`. If zero GPUs or command missing →
     error, offer to fall back to ElevenLabs.
   - Intel Mac → refuse, point at ElevenLabs.

2. **Model size prompt.**
   Print a table and let the user pick:

   ```
   Model size (higher = better, slower, more memory):

     small   ~4GB mem   ~15-30s per track   OK for background music
     medium  ~8GB mem   ~60s per track      recommended
     large   ~16GB mem  ~2-3min per track   best quality, slowest

   Size [medium]:
   ```

   Validate against detected memory where possible (M1 base 8GB → warn on
   medium, refuse large).

3. **Python bootstrap via uv.**
   - Check for `uv` on PATH. If missing, prompt to install:
     - macOS/Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh`
     - Windows: `powershell -c "irm https://astral.sh/uv/install.ps1 | iex"`
   - `uv venv ~/.vibe/venv --python 3.11`
   - `uv pip install --python ~/.vibe/venv/bin/python torch audiocraft`
     (Linux/Windows + Nvidia: default PyPI wheel, which bundles a recent
     CUDA 12.x runtime and is forward-compat with CUDA 13 drivers. Users can
     pin a specific CTK via `--cuda 12.4` etc., which routes to the matching
     `cu{major}{minor}` wheel index.)
   - Store the absolute venv python path in `config.local.pythonPath`.

4. **Model download.**
   - Shell out to the venv python with a one-shot script that triggers
     `audiocraft` to download the chosen model size into `~/.vibe/models`.
   - Show progress (audiocraft uses `huggingface_hub` which prints progress).
   - 2GB (small) to 10GB (large) depending on size. Warn before large.

5. **Smoke test.**
   - Spawn the worker, wait for ready.
   - POST `/generate` with a canned prompt, duration_s=5, tmp output path.
   - Verify file exists and is non-trivial size (> 10KB).
   - Log latency.
   - Kill worker.

6. **Welcome track pre-generation.**
   - Generate a "welcome" mood track now and cache it. This avoids the
     cold-start problem where daemon boot tries to play welcome music
     before the worker is ready.

7. **Write config.**
   `provider: "local"`, `local: { backend, size, device, workerPort, pythonPath, modelCacheDir }`.
   Force `vocals: false`.

Branching in setup: skip the ElevenLabs API key step (#1 of current flow) and
the vocals step (#5) entirely when local is chosen. Keep genre prefs, volume,
cache-per-mood, interesting-vibes, and cache-only mode — they all still apply.

## Platform/hardware support matrix

| Platform            | Device | Status    | Notes |
|---------------------|--------|-----------|-------|
| macOS arm64 ≥12.3   | mps    | supported | PyTorch MPS backend |
| macOS arm64 <12.3   | -      | reject    | MPS requires 12.3+ |
| macOS x86_64        | -      | reject    | No useful GPU path |
| Linux + Nvidia      | cuda   | supported | CUDA 12.x via torch wheel |
| Linux, no Nvidia    | -      | reject    | CPU too slow |
| Windows + Nvidia    | cuda   | supported | CUDA 12.x via torch wheel |
| Windows, no Nvidia  | -      | reject    | CPU too slow |
| Any + AMD           | -      | reject    | ROCm wheel matrix is out of scope |

Rejection message in setup: clear, points at ElevenLabs as the alternative.

## Cache behavior

No change. Local-generated tracks land in the same
`~/.vibe/cache/instrumental/<mood>/` directory as ElevenLabs tracks. The
playlist treats them identically: cap-based rotation, shuffle, prefetch.

Mixing is fine in theory: a user can warm up with ElevenLabs, then switch
to local, and keep hearing their ElevenLabs tracks from cache. The mood
prompts aren't backend-specific, so there's no content marker needed.

Cache-only mode is unaffected. If a user sets `cacheOnlyMode: true` with
`provider: "local"`, the worker never gets spawned (no generation will ever
happen) — small optimization in `createGenerator` to skip worker bootstrap
entirely in that case.

## Prompt tuning

MusicGen prompts behave differently from ElevenLabs prompts — tighter on
genre/instrumentation/tempo, looser on narrative mood descriptors. The
current `src/moods.ts` prompts are written for ElevenLabs.

Plan: **try the existing prompts first, don't add an override layer until we
see quality issues.** The `vibeDescriptor` strings in `MOOD_DEFINITIONS` are
actually pretty music-friendly already (e.g. "driving beat, determination...
dark and intense"). The `buildMusicPrompt` function also adds genre + "with
vocals"/"instrumental only" suffix — for local, we always pass instrumental,
which is the right signal anyway.

If a round of listening tests shows MusicGen is floundering on a specific
mood, add an optional `localPrompt` field to `MoodDefinition` in a follow-up.
Don't over-engineer upfront.

## File change list

**New files**

- `src/generators/types.ts` — interface, errors, options types
- `src/generators/index.ts` — `createGenerator(config)` factory
- `src/generators/elevenlabs.ts` — extracted from current `src/elevenlabs.ts`,
  implements `MusicGenerator`
- `src/generators/local.ts` — worker supervisor, implements `MusicGenerator`
- `src/cache.ts` — `getCachedTracks`, `getCacheDir` (moved from elevenlabs.ts)
- `python/worker.py` — HTTP server hosting the MusicGen model
- `python/requirements.txt` — pinned `audiocraft==1.3.0`; torch/torchaudio are installed separately by `scripts/install-local.mjs` with a platform-specific `--index-url`. The worker serves HTTP via Python's stdlib `http.server`, so no `fastapi`/`uvicorn` deps.
- `scripts/install-local.mjs` — called from setup, handles uv + venv + model download
- `scripts/smoke-local.mjs` — local-only smoke test that runs a real end-to-end generation against the spawned worker
- `docs/local-generation.md` — this file

**Modified**

- `src/elevenlabs.ts` — deleted or shrunk to re-export from `generators/elevenlabs.ts`
  (decide during refactor)
- `src/playlist.ts` — constructor takes `generator`, use injected instance,
  import cache helpers from `./cache.js`
- `src/daemon.ts` — use `createGenerator`, pass into Playlist, handle
  `GeneratorUnavailableError`
- `src/config.ts` — new schema, provider + local fields, load-time vocals
  force-off
- `src/setup.ts` — backend selection, hardware detection, uv install, model
  download, conditional branches for API key and vocals steps
- `scripts/smoke-ci.mjs` — switch from module-swap to dependency injection:
  construct a mock generator object and pass it into `new Playlist`. Removes
  the `.bak` file dance. Also adds a second variant that exercises the local
  path with a mock LocalGenerator (no worker spawn).
- `scripts/smoke-wiring.mjs` — same injection refactor for consistency
- `package.json` — new scripts: `setup:local`, `test:smoke:local`
- `CLAUDE.md` — document local mode, new files, new test tier
- `README.md` — add local mode to the feature list and setup instructions
- `.gitignore` — add `~/.vibe/venv` isn't relevant (outside tree) but
  `python/__pycache__` is

## Milestones

Rough order — each milestone ends with a runnable (if incomplete) daemon.

### M1: Refactor to provider abstraction (no behavior change)

1. Create `src/generators/types.ts` with interface + errors.
2. Create `src/cache.ts`, move `getCachedTracks`/`getCacheDir` there.
3. Create `src/generators/elevenlabs.ts`, make it implement `MusicGenerator`.
4. Update `src/elevenlabs.ts` to re-export or delete.
5. Update `src/playlist.ts` to take `generator` in constructor, use it.
6. Update `src/daemon.ts` to build generator and pass it in.
7. Update smoke-ci and smoke-wiring to use injection instead of module-swap.
8. Verify: `npm run test:ci` passes, manual run of the daemon still plays music.

This milestone is self-contained and shippable. If local gen work stalls,
M1 alone is still valuable as a cleanup.

### M2: Python worker (Apple Silicon only)

1. Write `python/worker.py` with `/health`, `/generate`, `/shutdown`.
2. Write `python/requirements.txt`.
3. Write `scripts/install-local.mjs` — uv bootstrap, venv, pip install,
   model download for MusicGen small on Apple Silicon only.
4. Run the worker manually with `uv run python/worker.py`, verify
   `/generate` produces a playable mp3.

No TypeScript changes yet — this milestone is just "Python works on my Mac."

### M3: LocalGenerator + daemon integration

1. Create `src/generators/local.ts` with worker supervisor.
2. Wire into `createGenerator` factory.
3. Add `provider` and `local` fields to config.
4. Daemon spawns worker on boot, gates welcome music on readiness.
5. Hand-test: set `config.provider = "local"`, start daemon, verify
   music plays.

### M4: Setup CLI

1. Add backend selection prompt as step 0.
2. Hardware detection for macOS arm64.
3. Model size selection.
4. Call `install-local.mjs` for the bootstrap.
5. Smoke test + welcome pre-generation.
6. Config write.

End of M4: user can run `npm run setup`, pick local, and have everything
just work on an M-series Mac.

### M5: Linux + Nvidia

1. Hardware detection: `nvidia-smi -L` parsing.
2. CUDA torch wheel install path in `install-local.mjs`.
3. Worker `device=auto` resolves to `cuda` when torch reports it.
4. Test on a Linux+Nvidia box (or a rented GPU VM).

### M6: Windows + Nvidia

1. uv install via PowerShell in setup.
2. Spawn flags: `shell: false`, absolute `python.exe` path.
3. Windows-specific path normalization in JSON messages.
4. Test on a Windows+Nvidia machine.

### M7: Docs, polish, smoke-local

1. `scripts/smoke-local.mjs` — real generation, gated on `VIBE_TEST_LOCAL=1`.
2. Update CLAUDE.md, README.md.
3. Merge.

Total rough estimate: **5–7 working days**, most of it in M2 (Python worker
reliability) and M6 (Windows quirks).

## Testing

### CI (smoke-ci.mjs)

Refactor to dependency injection — no more module swap. Construct a mock
`MusicGenerator` object:

```js
const mockGen = {
  name: "mock",
  async init() {},
  async shutdown() {},
  async generateTrack(opts) {
    captured.push(opts);
    return FAKE_MP3_PATH;
  },
};
const playlist = new Playlist({ /* ... */, generator: mockGen });
```

Add a second variant that mocks a `LocalGenerator` — same interface, just
asserts that `instrumental: true` is passed and `lyrics` is ignored.

### Local smoke (smoke-headless.mjs, smoke-wiring.mjs)

Both refactored to use injection. No change to what they exercise —
still hits the real `claude` CLI and (in smoke-headless) the real
ElevenLabs quota check.

### New: smoke-local.mjs

Gated on `VIBE_TEST_LOCAL=1`. Spins up the Python worker with the model
size from `~/.vibe/config.json`, runs a real `generateTrack()` via
`LocalGenerator`, verifies the file on disk, shuts down. Not run in CI —
GH Actions has no GPU and the model download is too large anyway.

### Manual test plan

Before merge:

- [ ] `npm run setup` with `provider: elevenlabs` still works (regression)
- [ ] `npm run setup` with `provider: local` on M2 Mac
- [ ] `npm run setup` with `provider: local` on Linux+Nvidia
- [ ] `npm run setup` with `provider: local` on Windows+Nvidia
- [ ] Daemon boots with local provider, plays welcome music within 90s
- [ ] Mood switch under load doesn't drop the worker
- [ ] Worker crash recovery: `kill -9` the Python PID, verify daemon
  restarts it once and surfaces error on second crash
- [ ] Cache from a prior ElevenLabs session still plays under local provider
- [ ] `/vibe setVocals on` is rejected / silently ignored in local mode
- [ ] Uninstall cleans up `~/.vibe/venv` and `~/.vibe/models`

## Risks & mitigations

**R1: Python packaging is the worst part of this project.**
Mitigation: uv handles almost everything, including downloading its own
Python. Pin Python 3.11 explicitly. Ship a `requirements.txt` with exact
versions to avoid torch/audiocraft ABI drift.

**R2: PyTorch MPS backend is still rough in places.**
Some ops fall back to CPU, some are numerically slightly different from
CUDA. For MusicGen this is mostly fine — the model is well-tested on MPS.
Worth validating the smoke test actually produces audible music on first
generation.

**R3: Worker process model is a new lifecycle concern.**
The daemon already manages the player subprocess; worker is a second
long-lived child. Use the same SIGTERM path on shutdown. Windows has no
SIGTERM — fall back to `proc.kill()`.

**R4: Large model downloads during setup feel bad.**
2–10GB in a setup script is rough. Mitigations: eager download in setup
(honest) rather than lazy on first run (surprising), clear progress
reporting, offer to skip and download later with `npm run setup:local`.

**R5: Thermals/battery on laptops.**
Generation pegs the GPU for 30–180s. On M-series laptops the fans will
spin up. Document it, add a `local.lowPowerMode: true` config that picks
the small model regardless of user choice. Future work.

**R6: Smoke test refactor could break hidden assumptions.**
`smoke-ci.mjs` currently module-swaps. If the injection refactor misses a
code path that still expects the module form, CI breaks. Mitigation: run
smoke-ci after every step of M1, not just at the end.

**R7: Apple Silicon memory pressure.**
M1/M2 base models have 8GB unified memory. Medium MusicGen needs ~6GB
active, which is tight alongside Claude Code + browser. Refuse `large`
on <16GB machines, warn on `medium` on 8GB machines.

## Open questions

**Q1: Should LocalGenerator pre-warm the worker on a config-change hook,
or only on daemon boot?**
Leaning: only on daemon boot. Config changes that affect the worker
(model size, device) require a daemon restart anyway — document it,
don't try to hot-swap.

**Q2: Do we offer a `provider: "auto"` that picks local if hardware is
compatible, else elevenlabs?**
Leaning: no, too surprising. Explicit choice during setup is clearer.

**Q3: Do we bundle a small pre-generated "starter pack" of local tracks
so new users aren't waiting on the worker for their first welcome music?**
Leaning: yes, but in a follow-up PR. For this one, the setup-time welcome
pre-generation solves the first-session case well enough.

**Q4: Worker-to-daemon security — should we use a shared secret on the
HTTP calls so a random process on the same machine can't hit it?**
Leaning: yes, generate a token on spawn, pass it via env var to the
worker, include it in every request. Low effort, no downside.

**Q5: Should failed worker startup fall back to ElevenLabs if an API key
is present?**
Leaning: no. Fail explicitly so the user knows local is broken and can
fix it, rather than silently burning credits.

## Rollback

If local generation has to be yanked post-merge:

1. Users with `provider: "local"` have their config force-migrated to
   `provider: "elevenlabs"` on next daemon boot, with an error in state
   asking them to re-run setup.
2. Worker process is never spawned, `~/.vibe/venv` and `~/.vibe/models`
   are left on disk (uninstall script can clean them up).
3. The provider abstraction refactor (M1) stays — it's a pure improvement
   and the ElevenLabs path goes through it identically.

So rollback means reverting M2–M7 and leaving M1 merged. Git-wise, this
argues for M1 being its own PR, merged first, and M2–M7 being a second
PR that stacks on top. **Recommend: split into two PRs.**

## Decision log

Decisions already made in this plan that future-us might want to revisit:

- **Worker protocol is HTTP, not stdin JSONL.** For debugability. Can
  revisit if the second HTTP server causes port allocation problems.
- **uv for Python, not system Python or conda.** For UX. Can revisit if
  uv turns out to have a showstopper bug on one of our platforms.
- **MusicGen first, Stable Audio Open as a follow-up.** audiocraft is
  more mature and covers both hardware targets with one codebase.
- **Injection refactor of Playlist constructor.** Cleaner smoke tests,
  easier to swap providers, small blast radius.
- **Eager model download during setup.** Honest > surprising.
- **Setup-time welcome pre-generation.** Solves cold-start without adding
  complexity to the daemon boot path.
- **Token-authenticated worker HTTP.** Cheap security hygiene.
- **Split into two PRs** (refactor, then local backend) for reviewability
  and rollback.
