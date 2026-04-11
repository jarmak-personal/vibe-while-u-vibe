import { buildGenrePrompt, pickGenreSelections } from "./genres.js";

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

interface LocalMoodPromptRecipe {
  rhythm: string;
  energy: string;
}

const LOCAL_MOOD_PROMPTS: Record<Mood, LocalMoodPromptRecipe> = {
  welcome: {
    rhythm: "gentle pulse and soft momentum",
    energy: "warm, inviting background energy",
  },
  focus: {
    rhythm: "steady midtempo groove with hypnotic forward motion",
    energy: "focused, unobtrusive background energy",
  },
  debug: {
    rhythm: "driving pulse with tight rhythmic motion",
    energy: "tense, determined energy",
  },
  explore: {
    rhythm: "loose midtempo groove with light movement",
    energy: "curious, airy atmosphere",
  },
  test: {
    rhythm: "clean, precise groove with confident momentum",
    energy: "methodical and upbeat feel",
  },
  ship: {
    rhythm: "upbeat drums and rising momentum",
    energy: "bright, triumphant energy",
  },
  refactor: {
    rhythm: "minimal steady pulse with restrained drums",
    energy: "calm, precise atmosphere",
  },
  design: {
    rhythm: "laid-back groove with thoughtful movement",
    energy: "creative, cerebral mood",
  },
  struggle: {
    rhythm: "fast pulsing drums with relentless motion",
    energy: "dark, high-energy tension",
  },
};

const LOCAL_GENRE_INSTRUMENTS: Record<string, string> = {
  electronic: "warm analog synths, arpeggiators, and drum machines",
  ambient: "soft pads, drones, and sparse percussion",
  lofi: "dusty drums, warm keys, and tape texture",
  rock: "guitars, bass, and live drums",
  metal: "distorted guitars, heavy drums, and bass",
  jazz: "electric piano, bass, and brushed drums",
  classical: "strings, piano, and orchestral textures",
  hiphop: "punchy drums, bass, and chopped melodic samples",
  world: "hand percussion and organic melodic instruments",
  funk: "bass groove, rhythm guitar, keys, and drums",
  experimental: "glitchy textures, unusual timbres, and fragmented percussion",
  country: "acoustic guitar, warm bass, and brushed drums",
};

/**
 * Build a full music prompt by combining mood vibe + genre selection + vocal preference.
 * An optional genreHint is prepended to the genre portion to steer generation (e.g. "more metal").
 * Lyrics (when vocals is on) are attached by the generator, not here.
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

export function buildLocalMusicPrompt(
  mood: Mood,
  excludedGenres: string[],
  interestingVibes: boolean,
  genreHint?: string | null
): string {
  // This is a teaching scaffold for MusicGen-style prompts, not sacred text.
  // Preserve the *shape* Meta's examples respond well to (short natural
  // descriptions with genre / instrumentation / rhythm / energy cues), but
  // feel free to evolve the wording and vary the phrasing when improving the
  // local backend. Do not cargo-cult these exact strings.
  const picks = pickGenreSelections(excludedGenres, interestingVibes ? 2 : 1);
  const primary = picks[0];
  const secondary = picks[1] ?? null;
  const recipe = LOCAL_MOOD_PROMPTS[mood];
  const steer = genreHint ? `${genreHint}-leaning ` : "";

  const intro = secondary
    ? `Instrumental ${steer}cross-genre track blending ${primary.subGenre} and ${secondary.subGenre}`
    : `Instrumental ${steer}${primary.subGenre} track`;

  const instrumentation = secondary
    ? `${LOCAL_GENRE_INSTRUMENTS[primary.genreId] ?? "melodic textures and percussion"}, with touches of ${LOCAL_GENRE_INSTRUMENTS[secondary.genreId] ?? "contrasting textures"}`
    : LOCAL_GENRE_INSTRUMENTS[primary.genreId] ?? "melodic textures and percussion";

  return [
    intro,
    instrumentation,
    recipe.rhythm,
    recipe.energy,
  ]
    .filter((part): part is string => Boolean(part))
    .join(", ");
}
