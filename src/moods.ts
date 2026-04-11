import { buildGenrePrompt } from "./genres.js";

export type Mood =
  | "welcome"
  | "focus"
  | "debug"
  | "explore"
  | "test"
  | "ship"
  | "refactor"
  | "design"
  | "struggle";

export interface MoodDefinition {
  mood: Mood;
  label: string;
  /** The emotional/energy descriptor — genre is layered on top at generation time */
  vibeDescriptor: string;
}

export const MOOD_DEFINITIONS: Record<Mood, MoodDefinition> = {
  welcome: {
    mood: "welcome",
    label: "Welcome",
    vibeDescriptor:
      "warm and inviting chillwave, dreamy synth washes, gentle nostalgia, a new session begins",
  },
  focus: {
    mood: "focus",
    label: "Deep Focus",
    vibeDescriptor:
      "steady gentle rhythm, concentration and flow state, hypnotic and locked-in",
  },
  debug: {
    mood: "debug",
    label: "Debug Mode",
    vibeDescriptor:
      "driving beat, determination and problem-solving energy, dark and intense",
  },
  explore: {
    mood: "explore",
    label: "Code Explorer",
    vibeDescriptor:
      "chill exploratory vibes, relaxed curiosity, wandering and open",
  },
  test: {
    mood: "test",
    label: "Test Runner",
    vibeDescriptor:
      "methodical and confident rhythm, clean precise beats, positive forward momentum",
  },
  ship: {
    mood: "ship",
    label: "Ship It!",
    vibeDescriptor:
      "triumphant and celebratory, achievement unlocked, soaring and climactic",
  },
  refactor: {
    mood: "refactor",
    label: "Zen Refactor",
    vibeDescriptor:
      "calm and precise, meditative clarity, soft flowing textures, minimal",
  },
  design: {
    mood: "design",
    label: "Architect",
    vibeDescriptor:
      "creative thinking vibes, imaginative and open, laid-back and cerebral",
  },
  struggle: {
    mood: "struggle",
    label: "Boss Fight",
    vibeDescriptor:
      "building intensity, powerful and relentless, never give up energy, epic",
  },
};

export const ALL_MOODS = Object.keys(MOOD_DEFINITIONS) as Mood[];

/** Moods the classifier can pick from — excludes welcome (startup-only). */
export const CLASSIFIABLE_MOODS: Mood[] = ALL_MOODS.filter((m) => m !== "welcome");

/** Most likely next moods for each mood — used for speculative pre-generation. */
export const MOOD_TRANSITIONS: Record<Mood, Mood[]> = {
  welcome: ["focus", "explore"],
  focus: ["debug", "test", "ship"],
  debug: ["struggle", "focus", "test"],
  explore: ["focus", "design"],
  test: ["debug", "ship", "focus"],
  ship: ["focus", "explore"],
  refactor: ["focus", "test"],
  design: ["focus", "refactor"],
  struggle: ["debug", "focus"],
};

/**
 * Build a full music prompt by combining mood vibe + genre selection + vocal preference.
 * An optional genreHint is prepended to the genre portion to steer generation (e.g. "more metal").
 * Lyrics (when vocals is on) are attached by the ElevenLabs client, not here.
 */
export function buildMusicPrompt(
  mood: Mood,
  excludedGenres: string[],
  interestingVibes: boolean,
  vocals: boolean,
  genreHint?: string | null
): string {
  const def = MOOD_DEFINITIONS[mood];
  const genre = buildGenrePrompt(excludedGenres, interestingVibes);

  const genrePart = genreHint ? `${genreHint}, ${genre}` : genre;
  const parts = [genrePart, def.vibeDescriptor];

  // The prompt text has to agree with the API's forceInstrumental flag. The
  // caller passes `instrumental: !vocals` to the API, so the prompt should
  // say "with vocals" whenever vocals is on — even if the lyrics string is
  // empty (which happens when the lyrics-generation Haiku call errored out).
  if (vocals) {
    parts.push("with vocals");
  } else {
    parts.push("instrumental only");
  }

  return parts.join(", ");
}
