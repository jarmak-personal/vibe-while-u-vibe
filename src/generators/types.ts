import type { Mood } from "../moods.js";

export interface GenerateOptions {
  mood: Mood;
  musicPrompt: string;
  lyrics?: string | null;
  instrumental: boolean;
}

export interface MusicGenerator {
  readonly name: string;
  readonly promptStyle?: "default" | "musicgen";
  init(): Promise<void>;
  shutdown(): Promise<void>;
  generateTrack(opts: GenerateOptions): Promise<string>;
}

export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

export class GeneratorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeneratorUnavailableError";
  }
}
