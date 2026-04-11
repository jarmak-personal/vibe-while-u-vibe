# vibe-while-u-vibe

AI-generated music that matches the vibe of your Claude Code session. Debugging? Synthwave. Shipping? Triumphant orchestral. Refactoring? Zen ambient. All automatic, all in the background.

## How it works

```
You code with Claude Code
        |
   CC hooks fire on every tool use, prompt, and turn
        |
   Events stream to a local daemon (localhost:7773)
        |
   Haiku classifies the session "mood" from recent activity
        |
   ElevenLabs generates a 3-min track from randomized sub-genres
        |
   Plays in the background (afplay / ffplay / WMP), looping and caching
        |
   Status line shows:  ♫ Deep Focus
```

The daemon watches what's happening in your session — file edits, test runs, git commands, error messages — and uses a lightweight LLM call (Haiku) to classify the current vibe into one of 8 moods. When the mood shifts, it picks random sub-genres from your allowed genre pool, generates new music via ElevenLabs, and starts playing. Tracks are cached locally so repeated moods don't burn API credits.

## Moods

| Mood | When | Vibe |
|------|------|------|
| **Deep Focus** | Writing new code, implementing features | Steady, hypnotic, locked-in |
| **Debug Mode** | Fixing bugs, investigating errors | Driving, determined, intense |
| **Code Explorer** | Reading code, searching, browsing | Chill, curious, wandering |
| **Test Runner** | Running or writing tests | Methodical, confident, forward momentum |
| **Ship It!** | Git commits, PRs, deployments | Triumphant, celebratory, climactic |
| **Zen Refactor** | Restructuring, renaming, cleanup | Calm, precise, meditative |
| **Architect** | Planning, discussing architecture | Creative, cerebral, laid-back |
| **Boss Fight** | Repeated failures, long debugging | Epic, relentless, never give up |

The actual music style comes from the genre system — your mood sets the energy, your genre preferences set the sound.

## Genres

12 main genres, each with 12-18 sub-genres that are **randomly selected** at generation time so you never hear the same thing twice:

| Genre | Example Sub-Genres |
|-------|--------------------|
| Electronic | synthwave, vaporwave, future bass, minimal techno, electro swing... |
| Ambient | dark ambient, space ambient, cosmic ambient, drone, microsound... |
| Lo-Fi | lo-fi hip hop, chillhop, jazzhop, lo-fi bossa nova, study beats... |
| Rock | post-rock, math rock, shoegaze, krautrock, midwest emo... |
| Metal | djent, post-metal, doom metal, blackgaze, symphonic metal... |
| Jazz | jazz fusion, acid jazz, Ethio-jazz, bebop, spiritual jazz... |
| Classical | neo-classical, film score, epic orchestral, spectral music... |
| Hip-Hop | boom bap, phonk, cloud rap, abstract hip hop, trip hop... |
| World | Afrobeat, cumbia digital, gamelan, Tuvan throat singing, desert blues... |
| Funk / Soul | p-funk, neo-soul, future funk, boogie, psychedelic soul... |
| Experimental | musique concrete, plunderphonics, deconstructed club, hauntology... |
| Country / Folk | alt-country, bluegrass, psych folk, cowpunk, gothic Americana... |

During setup, you can exclude any genres you don't want. The rest are fair game.

### Interesting Vibes Mode

Turn this on if you want to live dangerously. Instead of picking clean sub-genres, the system mashes genres together:

- *didgeridoo ambient meets melodic death metal*
- *Tuvan throat singing rhythms over lo-fi hip hop textures*
- *Ethio-jazz harmonies with doom metal intensity*
- *cumbia digital fused with boom bap beats*
- *prepared piano approach to chillhop*

Every track is a surprise.

## Vocals Mode

By default, tracks are instrumental. Turn on **vocals mode** and Haiku will write short, witty lyrics about what you're actually doing in your coding session — then ElevenLabs sings them.

Debugging auth middleware? You might hear a verse about chasing down a rogue session token. Shipping a PR? Expect a triumphant chorus about merging to main.

## Requirements

- **Node.js >= 18**
- **Claude Code** (uses headless mode for mood classification)
- **[ElevenLabs API key](https://elevenlabs.io)** — see [credit budget](#elevenlabs-credit-budget) below; **Creator tier recommended**
- An audio playback backend for your OS:
  - **macOS**: `afplay` (pre-installed — nothing to do)
  - **Linux**: `ffplay` from [ffmpeg](https://ffmpeg.org/) — e.g. `sudo apt install ffmpeg` or `sudo dnf install ffmpeg`
  - **Windows**: PowerShell + Windows Media Player COM (pre-installed on Windows 10/11 — nothing to do)

### ElevenLabs credit budget

ElevenLabs Music is expensive. Each generated minute of audio burns about **1,500 credits**, and tiers stack additively — Starter gives you Free's 10k *plus* 30k, Creator adds another 121k on top:

| Tier | Credits / mo | Minutes of music | 3-min tracks |
|------|--------------|------------------|--------------|
| Free | 10,000 | ~6 min | ~2 tracks |
| Starter (Free + 30k) | 40,000 | ~27 min | ~9 tracks |
| **Creator (Free + Starter + 121k)** | **161,000** | **~107 min** | **~35 tracks** |

The daemon only generates on demand: a cache miss for the current mood (one track) plus a speculative prefetch of one likely next mood (one track). A typical session that bounces through a few moods generates **~2-4 new tracks (~9-18k credits)**. Cached tracks are reused across sessions, so the cost tapers off as your mood cache fills in.

Even so, Free runs dry after a session or two and Starter won't last a week of daily use. **Creator ($22/mo) is the practical minimum** for regular use; heavier users will want Pro.

When your credits run out, cached tracks keep playing but the status line will show `⚠ ElevenLabs out of credits` and no new music will generate until you top up or upgrade.

## Install

```bash
git clone https://github.com/jarmak-personal/vibe-while-u-vibe.git
cd vibe-while-u-vibe
npm install
npm run build
npm run setup
```

The setup wizard will:
1. Ask for your ElevenLabs API key
2. Set your preferred volume
3. Let you exclude genres you don't want
4. Ask if you want **interesting vibes** (cross-genre mashups) or normal
5. Ask if you want **vocals** (Haiku writes lyrics) or instrumental
6. Install hook scripts to `~/.vibe/hooks/` and the `/vibe` skill to `~/.claude/skills/vibe/`
7. Patch `~/.claude/settings.json` with hooks and status line config

## Usage

Just start a Claude Code session. That's it.

The `SessionStart` hook launches the daemon automatically. As you work, hooks forward events to the daemon, which classifies your vibe and starts playing music. When your session ends, the daemon shuts down.

### Controlling the vibe from Claude Code

Setup installs a `/vibe` skill into `~/.claude/skills/vibe`. Inside any Claude Code session, just talk to it in plain English:

```
/vibe stop
/vibe louder
/vibe quieter
/vibe skip
/vibe play focus music
/vibe boss fight music
/vibe auto              # release a mood lock
/vibe play more metal
/vibe no more jazz
/vibe never play country again
/vibe turn vocals on
/vibe what's playing
```

The skill maps your phrase to a `/control` action and reports back in one line. Mood commands **lock** the classifier so it stops auto-switching — say `/vibe auto` to unlock.

### Raw HTTP control

If you'd rather hit the daemon directly:

```bash
PORT=$(cat ~/.vibe/daemon.port)

curl -X POST http://127.0.0.1:$PORT/control -d '{"action":"stop"}'
curl -X POST http://127.0.0.1:$PORT/control -d '{"action":"play"}'
curl -X POST http://127.0.0.1:$PORT/control -d '{"action":"pause"}'
curl -X POST http://127.0.0.1:$PORT/control -d '{"action":"resume"}'
curl -X POST http://127.0.0.1:$PORT/control -d '{"action":"skip"}'
curl -X POST http://127.0.0.1:$PORT/control -d '{"action":"volume","value":0.5}'
curl -X POST http://127.0.0.1:$PORT/control -d '{"action":"volumeDelta","delta":0.1}'
curl -X POST http://127.0.0.1:$PORT/control -d '{"action":"setMood","mood":"focus","lock":true}'
curl -X POST http://127.0.0.1:$PORT/control -d '{"action":"unlockMood"}'
curl -X POST http://127.0.0.1:$PORT/control -d '{"action":"setVocals","enabled":true}'
curl -X POST http://127.0.0.1:$PORT/control -d '{"action":"reclassify"}'
curl -X POST http://127.0.0.1:$PORT/control -d '{"action":"genreSteer","hint":"metal","scope":"session"}'
curl -X POST http://127.0.0.1:$PORT/control -d '{"action":"genreSteer","exclude":["country"],"scope":"persistent"}'

curl http://127.0.0.1:$PORT/status
```

## Architecture

```
~/.claude/settings.json              ~/.vibe/
  hooks:                               config.json      (API keys, prefs, genres)
    SessionStart     -> start-daemon   state.json       (current mood/track for status line)
    SessionEnd       -> stop-daemon    daemon.pid       (lifecycle management)
    PostToolUse      -> send-event     daemon.port      (port the HTTP server bound to)
    UserPromptSubmit -> send-event     daemon.log       (daemon output)
    Stop             -> send-event     hooks/           (installed hook scripts)
  statusLine:                          cache/
    -> status-line.mjs                   focus/         (cached mp3s by mood)
                                         debug/
                                         explore/
                                         ...

The `stop-daemon` hook doesn't actually kill the daemon — it forwards the
SessionEnd event, and the daemon shuts itself down once its last session ends.
```

### Key design decisions

- **Async hooks** — all hooks run with `async: true` so they never block Claude Code
- **Debounced classification** — only reclassifies after 5+ new events or 2 minutes, not on every keystroke
- **Cache-first playback** — cached tracks play instantly; on a cache miss the current track keeps looping while the new one generates
- **Credit conservation** — generate only on demand: one track per cache-miss mood, plus a single speculative prefetch of a likely next mood. Only one generation in flight at a time, and cache persists across sessions so repeated moods are free
- **Lightweight audio** — `afplay` on macOS, `ffplay` on Linux, and Windows Media Player (via PowerShell COM) on Windows. Only Linux needs an install: `ffmpeg`
- **Randomized sub-genres** — every generation picks different sub-genres, so the music stays fresh even across sessions
- **Vocal tracks are never cached** — each vocal track gets unique lyrics about what you're doing right now

## Configuration

`~/.vibe/config.json`:

```json
{
  "elevenLabsApiKey": "sk-...",
  "volume": 0.3,
  "port": 7773,
  "enabled": true,
  "excludedGenres": ["metal", "country"],
  "interestingVibes": false,
  "vocals": false
}
```

Mood classification uses Claude Code headless mode (`claude --print`) — no separate API key needed.

> **Note on the API key:** `~/.vibe/config.json` is written with `0600` permissions, but the ElevenLabs key is stored in plaintext. If you'd rather not commit a key to disk at all, leave the `elevenLabsApiKey` field blank and export `ELEVENLABS_API_KEY` in your shell instead — the env var takes precedence.

## Uninstall

```bash
npm run uninstall                      # interactive
npm run uninstall -- --keep-cache      # scripted, keep ~/.vibe/cache
npm run uninstall -- --yes             # scripted, remove everything
```

Removes the daemon hooks from `~/.claude/settings.json`, deletes `~/.vibe/` (config, hooks, state), and removes the `/vibe` skill. Interactive mode also asks whether to keep the cached tracks so you don't lose music you liked — a future reinstall will pick them back up automatically. Or just tell Claude `/vibe uninstall` inside any session.

## License

MIT
