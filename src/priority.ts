import type { Mood } from "./moods.js";

/**
 * Event weight table — higher weight = more likely this session is "active".
 * Based on how engaged the user is with this particular session.
 */
const EVENT_WEIGHTS: Record<string, number> = {
  // User is actively driving this session
  "UserPromptSubmit": 10,

  // High-signal tool use
  "Write": 9,
  "Edit": 9,
  "Bash": 8,

  // Plan lifecycle — major engagement signals
  "ExitPlanMode": 10,
  "EnterPlanMode": 7,

  // Medium engagement
  "Read": 5,
  "Grep": 4,
  "Glob": 4,
  "Agent": 6,

  // Low — turn ended, might be idle
  "Stop": 2,
};

const DECAY_HALF_LIFE_MS = 30_000; // Priority halves every 30 seconds

export interface SessionState {
  sessionId: string;
  currentMood: Mood | null;
  currentLyrics: string | null;
  lastEventTime: number;
  lastEventWeight: number;
  alive: boolean;
}

/**
 * Calculate the current priority score for a session.
 * Score = lastEventWeight * 2^(-timeSinceEvent / halfLife)
 *
 * Decays from the *most recent* event's weight, not a monotonic peak. A
 * session that once saw a heavy event but has only been idle since should
 * eventually lose to a session that's actively receiving new events — even
 * if the new session's events are individually smaller.
 */
export function calculatePriority(session: SessionState): number {
  if (!session.alive) return 0;
  const elapsed = Date.now() - session.lastEventTime;
  const decay = Math.pow(2, -elapsed / DECAY_HALF_LIFE_MS);
  return session.lastEventWeight * decay;
}

/**
 * Get the event weight for a hook event.
 * For PostToolUse, uses the tool_name for more granular weighting.
 */
export function getEventWeight(
  hookEventName: string,
  toolName?: string
): number {
  // For tool use events, weight by the specific tool
  if (
    (hookEventName === "PostToolUse" || hookEventName === "PreToolUse") &&
    toolName
  ) {
    return EVENT_WEIGHTS[toolName] ?? 3;
  }
  return EVENT_WEIGHTS[hookEventName] ?? 3;
}

/**
 * Given all session states, return the session that should drive the music.
 * Returns null if no sessions are alive.
 */
export function pickActiveSession(
  sessions: Map<string, SessionState>
): SessionState | null {
  let best: SessionState | null = null;
  let bestScore = 0;

  for (const session of sessions.values()) {
    if (!session.alive) continue;
    const score = calculatePriority(session);
    if (score > bestScore) {
      bestScore = score;
      best = session;
    }
  }

  return best;
}
