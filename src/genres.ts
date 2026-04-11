export interface Genre {
  id: string;
  label: string;
  subGenres: string[];
}

export interface GenreSelection {
  genreId: string;
  subGenre: string;
}

export const GENRES: Genre[] = [
  {
    id: "electronic",
    label: "Electronic",
    subGenres: [
      "synthwave", "vaporwave", "chillwave", "retrowave",
      "ambient techno", "deep house", "lo-fi house",
      "downtempo", "IDM", "glitch hop", "future bass",
      "trance", "progressive house", "minimal techno",
      "electro swing", "breakbeat", "UK garage",
      "hardwave", "dreamwave", "outrun",
    ],
  },
  {
    id: "ambient",
    label: "Ambient",
    subGenres: [
      "dark ambient", "space ambient", "drone ambient",
      "ambient dub", "ambient house", "new age",
      "meditation music", "nature soundscape", "cosmic ambient",
      "isolationism", "ambient industrial", "lowercase",
      "microsound", "field recording collage", "healing frequencies",
    ],
  },
  {
    id: "lofi",
    label: "Lo-Fi",
    subGenres: [
      "lo-fi hip hop", "lo-fi jazz", "lo-fi R&B",
      "chillhop", "jazzhop", "lo-fi bedroom pop",
      "lo-fi soul", "lo-fi bossa nova", "study beats",
      "tape music", "lo-fi dream pop", "lo-fi garage",
    ],
  },
  {
    id: "rock",
    label: "Rock",
    subGenres: [
      "post-rock", "math rock", "shoegaze",
      "progressive rock", "stoner rock", "space rock",
      "krautrock", "noise rock", "art rock",
      "psychedelic rock", "surf rock", "garage rock",
      "midwest emo", "post-punk", "dream pop",
      "indie rock", "alt rock", "grunge",
    ],
  },
  {
    id: "metal",
    label: "Metal",
    subGenres: [
      "djent", "post-metal", "doom metal",
      "sludge metal", "atmospheric black metal", "symphonic metal",
      "progressive metal", "math metal", "blackgaze",
      "folk metal", "power metal", "thrash metal",
      "melodic death metal", "industrial metal", "gothic metal",
    ],
  },
  {
    id: "jazz",
    label: "Jazz",
    subGenres: [
      "jazz fusion", "acid jazz", "nu jazz",
      "modal jazz", "cool jazz", "spiritual jazz",
      "Ethio-jazz", "jazz funk", "smooth jazz",
      "bebop", "free jazz", "gypsy jazz",
      "Latin jazz", "jazz manouche", "chamber jazz",
    ],
  },
  {
    id: "classical",
    label: "Classical / Orchestral",
    subGenres: [
      "neo-classical", "modern classical", "minimalist classical",
      "cinematic orchestral", "baroque pop", "chamber music",
      "film score", "epic orchestral", "piano sonata",
      "string quartet", "contemporary classical", "post-minimalism",
      "spectral music", "orchestral glitch", "classical crossover",
    ],
  },
  {
    id: "hiphop",
    label: "Hip-Hop / Rap",
    subGenres: [
      "boom bap", "trap", "abstract hip hop",
      "cloud rap", "phonk", "memphis rap",
      "instrumental hip hop", "conscious rap", "jazz rap",
      "trip hop", "G-funk", "chopped and screwed",
      "UK grime", "drill", "crunk",
    ],
  },
  {
    id: "world",
    label: "World / Global",
    subGenres: [
      "Afrobeat", "Afro house", "cumbia digital",
      "reggae dub", "dancehall", "bossa nova",
      "flamenco fusion", "Celtic ambient", "Tuvan throat singing",
      "gamelan", "sitar drone", "didgeridoo ambient",
      "Balkan brass", "desert blues", "highlife",
      "qawwali fusion", "taiko drum", "mbira meditation",
    ],
  },
  {
    id: "funk",
    label: "Funk / Soul / R&B",
    subGenres: [
      "p-funk", "synth-funk", "disco funk",
      "neo-soul", "psychedelic soul", "quiet storm",
      "boogie", "future funk", "acid funk",
      "deep funk", "soul jazz", "northern soul",
      "modern R&B", "alternative R&B", "funk rock",
    ],
  },
  {
    id: "experimental",
    label: "Experimental / Avant-Garde",
    subGenres: [
      "musique concrete", "noise", "industrial",
      "sound collage", "plunderphonics", "microtonal",
      "prepared piano", "circuit bending", "algorithmic",
      "spectral", "tape loops", "generative music",
      "broken beat", "deconstructed club", "hauntology",
    ],
  },
  {
    id: "country",
    label: "Country / Folk / Acoustic",
    subGenres: [
      "alt-country", "outlaw country", "Americana",
      "bluegrass", "folk rock", "indie folk",
      "neofolk", "psych folk", "dark folk",
      "country blues", "cowpunk", "gothic Americana",
      "chamber folk", "anti-folk", "fingerstyle guitar",
    ],
  },
];

// Cross-genre mashup templates for "interesting vibes" mode
// Each is a template that combines unexpected genres
const MASHUP_TEMPLATES = [
  "{world} meets {electronic}",
  "{metal} with {jazz} influences",
  "{classical} fused with {hiphop} beats",
  "{country} mixed with {electronic} production",
  "{world} rhythms over {ambient} textures",
  "{funk} groove with {rock} energy",
  "{experimental} approach to {lofi}",
  "{jazz} harmonies with {metal} intensity",
  "{classical} arrangement meets {funk} bass",
  "{world} percussion driving {rock}",
  "{ambient} atmosphere with {hiphop} drums",
  "{electronic} synths over {country} guitar",
  "{experimental} textures under {jazz} melody",
  "{lofi} warmth with {classical} strings",
  "{metal} riffs softened by {ambient} pads",
  "{funk} horns over {electronic} bass drops",
  "{hiphop} flow on {world} instrumentation",
  "{rock} guitars with {world} scale modes",
];

/**
 * Pick random sub-genres from allowed main genres for a music prompt.
 * Returns 2-3 sub-genre descriptors.
 */
export function pickSubGenres(
  excludedGenreIds: string[],
  count = 2
): string[] {
  const allowed = GENRES.filter((g) => !excludedGenreIds.includes(g.id));
  if (allowed.length === 0) return ["ambient electronic"];

  const picked: string[] = [];
  for (let i = 0; i < count; i++) {
    const genre = allowed[Math.floor(Math.random() * allowed.length)];
    const sub =
      genre.subGenres[Math.floor(Math.random() * genre.subGenres.length)];
    if (!picked.includes(sub)) {
      picked.push(sub);
    }
  }
  return picked.length > 0 ? picked : ["ambient electronic"];
}

export function pickGenreSelections(
  excludedGenreIds: string[],
  count = 1
): GenreSelection[] {
  const allowed = GENRES.filter((g) => !excludedGenreIds.includes(g.id));
  if (allowed.length === 0) {
    return [{ genreId: "ambient", subGenre: "ambient electronic" }];
  }

  const picked: GenreSelection[] = [];
  const seen = new Set<string>();
  let attempts = 0;
  const maxAttempts = Math.max(8, count * 6);

  while (picked.length < count && attempts < maxAttempts) {
    attempts++;
    const genre = allowed[Math.floor(Math.random() * allowed.length)];
    const subGenre =
      genre.subGenres[Math.floor(Math.random() * genre.subGenres.length)];
    const key = `${genre.id}:${subGenre}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push({ genreId: genre.id, subGenre });
  }

  return picked.length > 0
    ? picked
    : [{ genreId: "ambient", subGenre: "ambient electronic" }];
}

/**
 * Generate a wild cross-genre mashup descriptor for "interesting vibes" mode.
 */
export function pickMashup(excludedGenreIds: string[]): string {
  const allowed = GENRES.filter((g) => !excludedGenreIds.includes(g.id));
  if (allowed.length < 2) return pickSubGenres(excludedGenreIds).join(", ");

  const template =
    MASHUP_TEMPLATES[Math.floor(Math.random() * MASHUP_TEMPLATES.length)];

  // Pick two different genres and grab a sub-genre from each
  const shuffled = [...allowed].sort(() => Math.random() - 0.5);
  const genreA = shuffled[0];
  const genreB = shuffled[1];
  const subA =
    genreA.subGenres[Math.floor(Math.random() * genreA.subGenres.length)];
  const subB =
    genreB.subGenres[Math.floor(Math.random() * genreB.subGenres.length)];

  return template
    .replace(`{${genreA.id}}`, subA)
    .replace(`{${genreB.id}}`, subB)
    // If template had genre IDs we didn't match, fill with random subs
    .replace(/\{(\w+)\}/g, () => {
      const g = allowed[Math.floor(Math.random() * allowed.length)];
      return g.subGenres[Math.floor(Math.random() * g.subGenres.length)];
    });
}

/**
 * Build the genre portion of a music prompt, respecting user preferences.
 */
export function buildGenrePrompt(
  excludedGenreIds: string[],
  interestingVibes: boolean
): string {
  if (interestingVibes) {
    return pickMashup(excludedGenreIds);
  }
  return pickSubGenres(excludedGenreIds, 2).join(" with ");
}
