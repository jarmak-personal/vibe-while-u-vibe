---
name: vibe
description: User-facing control skill for vibe-while-u-vibe. Use when the user says things like "/vibe stop", "/vibe louder", "/vibe skip", "play focus music", "what's playing", "where are my tracks", "/vibe disable", or "/vibe uninstall".
user-invocable: true
---

# vibe

You control `vibe-while-u-vibe`, a background music daemon that plays AI-generated music during coding sessions.

Start by reading:
- `~/.vibe/config.json` to determine `provider` (`elevenlabs` or `local`)
- `~/.vibe/state.json` for live playback state

Two hidden backend skills may also apply:
- `vibe-local` when `config.provider === "local"`
- `vibe-elevenlabs` when `config.provider === "elevenlabs"`

## Daemon access

Read the port from `~/.vibe/daemon.port`, then POST JSON to `http://127.0.0.1:$PORT/control`.

macOS/Linux:
```bash
PORT=$(cat ~/.vibe/daemon.port 2>/dev/null)
if [ -z "$PORT" ]; then
  echo "vibe daemon isn't running — start a Claude Code session to kick it off"
  exit 0
fi
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"action":"stop"}' \
  "http://127.0.0.1:$PORT/control"
```

Portable Node fallback:
```bash
node -e "fetch('http://127.0.0.1:PORT/control',{method:'POST',headers:{'Content-Type':'application/json'},body:'{\"action\":\"stop\"}'}).then(r=>r.text()).then(console.log)"
```

## Proactive nudges

You may silently nudge the daemon when the vibe is obviously wrong.

Rules:
- Prefer `{"action":"reclassify"}`.
- If highly confident, use `{"action":"setMood","mood":"focus","lock":false}` style nudges.
- Never override an explicit user lock.
- Don't nudge repeatedly within a couple of minutes.

## Command mapping

### Playback

- stop, off, silence: `{"action":"stop"}`
- play, start: `{"action":"play"}`
- pause: `{"action":"pause"}`
- resume: `{"action":"resume"}`
- skip, next: `{"action":"skip"}`

### Volume

- louder: `{"action":"volumeDelta","delta":0.1}`
- quieter: `{"action":"volumeDelta","delta":-0.1}`
- way louder: `{"action":"volumeDelta","delta":0.2}`
- mute: `{"action":"volume","value":0}`
- volume 50%: `{"action":"volume","value":0.5}`
- max volume: `{"action":"volume","value":1}`

Volume changes apply on the next track. If the user wants it now, follow with `skip`.

### Mood

Valid moods: `focus`, `debug`, `explore`, `test`, `ship`, `refactor`, `design`, `struggle`.

- explicit mood requests should lock: `{"action":"setMood","mood":"focus","lock":true}`
- auto/unlock: `{"action":"unlockMood"}`
- reclassify: `{"action":"reclassify"}`

Map user feelings to the nearest mood when needed.

### Genre steering

Scopes:
- `once`: next generated track only
- `session`: daemon lifetime
- `persistent`: save to config

Common mappings:
- more metal: `{"action":"genreSteer","hint":"metal","scope":"session"}`
- more metal just this track: `{"action":"genreSteer","hint":"metal","scope":"once"}`
- always make it metal: `{"action":"genreSteer","hint":"metal","scope":"persistent"}`
- no more jazz: `{"action":"genreSteer","exclude":["jazz"],"scope":"session"}`
- never play country again: `{"action":"genreSteer","exclude":["country"],"scope":"persistent"}`
- stop steering: `{"action":"genreSteer","hint":null,"scope":"session"}`

Known genre ids for excludes: `electronic`, `ambient`, `lofi`, `rock`, `metal`, `jazz`, `classical`, `hiphop`, `world`, `funk`, `experimental`, `country`.

### Vocals

Backend-specific rules live in the hidden skills. Check `config.provider` first.

- vocals on: `{"action":"setVocals","enabled":true}`
- vocals off / instrumental only: `{"action":"setVocals","enabled":false}`

### Status

If the user asks what's playing or asks for status, do not POST anything. Read `~/.vibe/state.json` and answer in one line:

`Playing: [trackLabel] ([currentMood]), vol [volume][, locked][, steering: X]`

If `playing` is false, say `Nothing playing.`

### Where

If asked where tracks live, answer:

```text
Cached tracks live under ~/.vibe/cache/, split by variant:
  ~/.vibe/cache/instrumental/<mood>/*.mp3
  ~/.vibe/cache/vocals/<mood>/*.mp3
```

Only open the cache directory if the user explicitly asks.

### Disable / enable

`disable` is not the same as `stop`. It keeps the daemon from respawning.

Disable:
```bash
echo "disabled by /vibe disable" > ~/.vibe/disabled
if [ -f ~/.vibe/daemon.pid ]; then
  kill "$(cat ~/.vibe/daemon.pid)" 2>/dev/null
fi
```

Enable:
```bash
rm -f ~/.vibe/disabled
```

### Uninstall

Always confirm first.

On confirmation, read `~/.vibe/uninstall-path` and run:
```bash
node "<path from uninstall-path>" --yes
```

If missing, fall back to `npm run uninstall`.

## Response style

Reply with one short sentence.

Good:
- `Stopped.`
- `Volume 0.4 (next track).`
- `Locked to focus mood. Say /vibe auto to unlock.`
- `Playing: Debug Mode (debug), vol 0.3.`

Bad:
- raw JSON
- long explanations
