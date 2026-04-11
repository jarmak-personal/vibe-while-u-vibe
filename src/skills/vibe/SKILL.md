---
name: vibe
description: Control the vibe-while-u-vibe music daemon. Use when the user says things like "/vibe stop", "/vibe louder", "play some metal", "pause the music", "turn it down", "play focus music", "what's playing", "turn vocals on", "where are my tracks", "/vibe where", "/vibe disable", "/vibe shutdown", "/vibe enable", "/vibe uninstall". Covers playback (stop/play/pause/skip), volume (louder/quieter/mute/set), mood locking (play X mood / auto), genre steering (more X / no more Y), vocals toggle, status, cache location, disable/enable (daemon kill switch), and uninstall.
---

# vibe

You control `vibe-while-u-vibe`, a background music daemon that plays AI-generated music during coding sessions. The user has invoked you to change what's playing.

## How to talk to the daemon

The daemon is a local HTTP server. Read its port from `~/.vibe/daemon.port` (use the Read tool — it works on macOS, Linux, and Windows), then POST JSON to `/control`.

On macOS/Linux (bash):
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

On Windows (or anywhere Node is available — portable fallback): Read the port file with the Read tool to get the port, then POST with a one-liner that works in any shell:
```
node -e "fetch('http://127.0.0.1:PORT/control',{method:'POST',headers:{'Content-Type':'application/json'},body:'{\"action\":\"stop\"}'}).then(r=>r.text()).then(console.log)"
```
(replace `PORT` with the value you just read).

Read current state anytime with the Read tool on `~/.vibe/state.json` — it's a JSON file with `playing`, `currentMood`, `pendingMood`, `trackLabel`, `volume`, `paused`, `moodLocked`, `vocals`, `genreHint`, etc.

## Proactive intervention (no user request)

The daemon auto-classifies the vibe from Claude Code hooks, but it debounces aggressively and can lag real shifts by a minute or more. You — the assistant running in the session — often know the vibe has changed *before* the classifier catches on. You are allowed (and encouraged) to nudge the daemon when the shift is obvious.

**When to nudge, unprompted:**
- The work pivots hard — e.g. "chill planning discussion" turns into "knocking out a 20-task list" (→ `focus` or `struggle`).
- A long debug session finally resolves and the user is clearly shipping (→ `ship`).
- A refactor or design discussion begins (→ `refactor` / `design`).
- You can tell the current mood is wrong for what's happening right now and the contrast is jarring.

**How to nudge:**
- Prefer `{"action":"reclassify"}` — it's a hint, not a command. The classifier re-runs against recent events and picks its own mood. Lowest-risk option.
- If you're highly confident and the classifier keeps picking wrong, use `setMood` with `lock:false` so the classifier can still override later if the vibe shifts again:
  `{"action":"setMood","mood":"focus","lock":false}`
- Only use `lock:true` when the **user** explicitly asks for a mood. Proactive nudges should never lock.

**When NOT to nudge:**
- `moodLocked` is true in state.json — the user picked a mood, respect it.
- You already nudged within the last couple of minutes — the daemon has a built-in 60s minimum mood lifetime to prevent thrash, and nudging faster just piles up no-ops.
- The vibe shift is subtle or speculative. If you're guessing, let the classifier do its thing.

**Important:** the daemon pre-generates the new track in the background and won't cut the current track until (a) 60s have elapsed on the current mood AND the new track is ready, or (b) the current track finishes naturally. So a proactive nudge is *cheap* — it won't thrash audio even if you're slightly off. Don't be shy.

Proactive nudges should be silent — don't announce them to the user. They're background behavior. Only surface the mood change if the user asks.

## Figuring out what the user wants

Map the user's phrase to exactly one action below. If truly ambiguous, ask one short clarifying question. If it's not about music, say so.

### Playback

| Phrase like…                          | Action                                        |
|---------------------------------------|-----------------------------------------------|
| stop, off, kill it, silence, quiet    | `{"action":"stop"}`                           |
| play, start, back on, music on        | `{"action":"play"}`                           |
| pause, hold on                        | `{"action":"pause"}`                          |
| resume, unpause, continue             | `{"action":"resume"}`                         |
| skip, next, change track, new song    | `{"action":"skip"}`                           |

### Volume

The daemon's volume is a float 0.0–1.0. Read the current volume from `~/.vibe/state.json` first if the user says "louder" or "quieter" and you want to report the new value.

| Phrase like…                          | Action                                        |
|---------------------------------------|-----------------------------------------------|
| louder, turn up, crank it, more       | `{"action":"volumeDelta","delta":0.1}`        |
| quieter, turn down, softer, less      | `{"action":"volumeDelta","delta":-0.1}`       |
| way louder, a lot louder              | `{"action":"volumeDelta","delta":0.2}`        |
| mute                                  | `{"action":"volume","value":0}`               |
| volume 50%, set volume to 0.4         | `{"action":"volume","value":0.5}`             |
| max volume, full blast                | `{"action":"volume","value":1}`               |

Volume changes apply on the **next track**, not the currently-playing one. If the user wants it right now, follow up with a `skip`.

### Mood

Valid moods: `welcome`, `focus`, `debug`, `explore`, `test`, `ship`, `refactor`, `design`, `struggle`.

When the user explicitly asks for a mood, **lock it** so the automatic classifier doesn't override it seconds later. The lock stays until they say "auto" (or equivalent).

| Phrase like…                          | Action                                                           |
|---------------------------------------|------------------------------------------------------------------|
| play focus music, focus mode          | `{"action":"setMood","mood":"focus","lock":true}`                |
| boss fight music, struggle mode       | `{"action":"setMood","mood":"struggle","lock":true}`             |
| ship it music, celebrate              | `{"action":"setMood","mood":"ship","lock":true}`                 |
| chill / explore music                 | `{"action":"setMood","mood":"explore","lock":true}`              |
| refactor / zen music                  | `{"action":"setMood","mood":"refactor","lock":true}`             |
| design / architect music              | `{"action":"setMood","mood":"design","lock":true}`               |
| debug music                           | `{"action":"setMood","mood":"debug","lock":true}`                |
| test music                            | `{"action":"setMood","mood":"test","lock":true}`                 |
| auto, unlock, let it pick again       | `{"action":"unlockMood"}`                                        |
| re-read the vibe, reclassify          | `{"action":"reclassify"}`                                        |

If the user names a feeling rather than a mood ("something chill", "something intense"), map it to the closest mood: chill→explore, intense→struggle, celebratory→ship, focused→focus, etc.

### Genre steering

Three scopes:
- `once`: apply to the very next generated track, then forget.
- `session`: apply for the rest of this daemon's lifetime.
- `persistent`: write to config — survives restarts.

Scope defaults to `session` unless the user says otherwise ("just this one track" → once, "never again" → persistent).

Known genre IDs (for `exclude`): `electronic`, `ambient`, `lofi`, `rock`, `metal`, `jazz`, `classical`, `hiphop`, `world`, `funk`, `experimental`, `country`. If the user names a sub-genre like "djent" or "synthwave", map to the parent ID for excludes, but pass the exact phrase as `hint` for steering.

| Phrase like…                                | Action                                                                   |
|---------------------------------------------|--------------------------------------------------------------------------|
| more metal, heavier, djent-ier              | `{"action":"genreSteer","hint":"metal","scope":"session"}`               |
| play more metal just for this track         | `{"action":"genreSteer","hint":"metal","scope":"once"}`                  |
| always make it metal                        | `{"action":"genreSteer","hint":"metal","scope":"persistent"}`            |
| no more jazz, stop playing jazz             | `{"action":"genreSteer","exclude":["jazz"],"scope":"session"}`           |
| never play country again                    | `{"action":"genreSteer","exclude":["country"],"scope":"persistent"}`     |
| clear the hint, stop steering, normal again | `{"action":"genreSteer","hint":null,"scope":"session"}`                  |
| play something weirder                      | `{"action":"genreSteer","hint":"weird experimental cross-genre","scope":"session"}` |

After genre steering, follow up with a `skip` **only if** the user's phrasing implies they want to hear the change right now ("play more metal NOW", "skip to the new genre"). Otherwise let the current track finish.

### Vocals

| Phrase like…                           | Action                                       |
|----------------------------------------|----------------------------------------------|
| turn vocals on, sing, add lyrics       | `{"action":"setVocals","enabled":true}`      |
| vocals off, instrumental only, no lyrics | `{"action":"setVocals","enabled":false}`   |

### Where are the tracks?

If the user asks "where are the songs?", "/vibe where", "show me the tracks", "open the cache", "where do you save the music", "where are my vocal tracks" — don't POST anything. Tell them:

```
Cached tracks live under ~/.vibe/cache/, split by variant:
  ~/.vibe/cache/instrumental/<mood>/*.mp3   ← rotated by the daemon
  ~/.vibe/cache/vocals/<mood>/*.mp3         ← every vocal track you've ever generated, kept around for you

ElevenLabs doesn't surface Music API tracks in your account library, so these folders are the only copy. Dig in and keep the ones you like.
```

On macOS, offer to open it: `open ~/.vibe/cache`. On Linux: `xdg-open ~/.vibe/cache`. On Windows: `explorer %USERPROFILE%\.vibe\cache`. Only run the opener if the user explicitly asks.

### Info / status

If the user asks "what's playing?", "what mood?", "status" — don't POST anything. Just read `~/.vibe/state.json` and summarize in one line:

```
Playing: [trackLabel] ([currentMood]), vol [volume][, locked][, steering: X]
```

If `playing` is false, say "Nothing playing."

### Disable / Enable (daemon kill switch)

Separate from `stop` (which only stops the current track). `disable` keeps the daemon *down* across future CC sessions so it can't respawn from the SessionStart hook and can't burn ElevenLabs credits. Use this when the user wants the thing truly off — debugging, saving credits, going on vacation.

It works via a sentinel file at `~/.vibe/disabled`. The SessionStart hook bails if the file exists.

| Phrase like…                                    | Action                                                        |
|-------------------------------------------------|---------------------------------------------------------------|
| disable, shutdown, kill it for good, stay down  | Create `~/.vibe/disabled`, then kill the running daemon (if any) |
| enable, bring it back, re-enable, turn it on    | Delete `~/.vibe/disabled`                                     |

**To disable** (bash):
```bash
echo "disabled by /vibe disable" > ~/.vibe/disabled
if [ -f ~/.vibe/daemon.pid ]; then
  kill "$(cat ~/.vibe/daemon.pid)" 2>/dev/null
fi
```
Then say: "Disabled. Daemon is down and won't respawn. Say `/vibe enable` to bring it back."

**To enable** (bash):
```bash
rm -f ~/.vibe/disabled
```
Then say: "Enabled. The daemon will start on your next Claude Code session (or run `claude` now to kick it off)."

Do NOT confuse `disable` with `stop`. `stop` is a playback command sent to the running daemon; `disable` keeps the daemon itself from running at all. If the user says "stop" they probably mean playback; if they say "shutdown", "disable", "kill it for good", or complain the daemon keeps coming back, they mean the kill switch.

### Help / list

If the user asks "help" or "what can I do", list the main categories briefly: playback, volume, mood, genre, vocals, status, where, disable/enable, uninstall. One line each.

### Uninstall

If the user says "uninstall", "remove vibe", "get rid of this", "delete vibe-while-u-vibe", or similar — this is **destructive** and removes the daemon, `~/.vibe/`, the hooks from `~/.claude/settings.json`, cached tracks, and this skill itself.

**Always confirm first.** Ask one short line like: "This will remove the daemon, config, cached tracks, hooks, and the `/vibe` skill itself. Proceed?" Wait for an affirmative reply ("yes", "y", "do it", "confirm") before running anything.

On confirmation, run the uninstall script non-interactively. Use the Read tool to read `~/.vibe/uninstall-path` (the file contains an absolute path to `uninstall.js`), then run that path with Node:

```
node "<path from uninstall-path>" --yes
```

If the file is missing, fall back to running `npm run uninstall` from the vibe-while-u-vibe repo.

After it runs, confirm in one line: "Uninstalled. Restart Claude Code to drop the hooks from this session." Note that `~/.claude/skills/vibe/` is removed by the script, so the skill itself goes away — future sessions won't have `/vibe` available.

## Executing the call

Run the curl as a single Bash command. Check the exit status and the daemon's response for `"ok":true`. If the daemon isn't running (no `daemon.port` file), tell the user plainly and stop.

## What to say back

One short sentence confirming what changed. Include the new state where useful.

Good:
- "Stopped."
- "Volume 0.4 (next track)."
- "Locked to focus mood. Say `/vibe auto` to unlock."
- "Steering toward metal for this session."
- "Excluding country permanently — saved to config."
- "Playing: Debug Mode (debug), vol 0.3."

Bad:
- Printing the JSON you sent.
- Narrating the curl call.
- Long multi-paragraph explanations.

If something fails (daemon down, invalid mood, unknown genre), say what failed in one line.
