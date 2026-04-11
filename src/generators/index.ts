import { type VibeConfig, getElevenLabsApiKey } from "../config.js";
import {
  type GenerateOptions,
  type MusicGenerator,
  GeneratorUnavailableError,
} from "./types.js";
import { ElevenLabsGenerator } from "./elevenlabs.js";
import { LocalGenerator } from "./local.js";

export interface GeneratorResult {
  generator: MusicGenerator;
  /** Non-null when the generator is a degraded stub — the daemon should
   *  surface this through state.error but keep running. */
  degradedReason: string | null;
}

export async function createGenerator(config: VibeConfig): Promise<GeneratorResult> {
  if (config.provider === "local") {
    if (!config.local) {
      const reason =
        "Local provider selected but no local config present. Run `npm run setup:local`.";
      return { generator: new StubGenerator(reason), degradedReason: reason };
    }
    // Local worker startup can take 30-120s while MusicGen loads weights.
    // Return the generator immediately so the daemon can bind its port and
    // start accepting events; the worker is warmed in the background.
    return { generator: new LocalGenerator(config.local), degradedReason: null };
  }

  const apiKey = getElevenLabsApiKey(config);
  if (!apiKey) {
    return {
      generator: new StubGenerator(
        "No ElevenLabs API key. Run `npm run setup` or set ELEVENLABS_API_KEY."
      ),
      degradedReason:
        "No ElevenLabs API key. Run `npm run setup` or set ELEVENLABS_API_KEY.",
    };
  }
  const gen = new ElevenLabsGenerator(apiKey);
  await gen.init();
  return { generator: gen, degradedReason: null };
}

/**
 * Generator that always throws GeneratorUnavailableError. Used when the real
 * generator can't be constructed (e.g. missing API key). Lets the Playlist's
 * existing error-handling code path surface the problem through state.error
 * without needing null checks at every call site.
 */
export class StubGenerator implements MusicGenerator {
  readonly name = "stub";
  readonly promptStyle = "default" as const;
  constructor(private readonly reason: string) {}
  async init(): Promise<void> {}
  async shutdown(): Promise<void> {}
  async generateTrack(_opts: GenerateOptions): Promise<string> {
    throw new GeneratorUnavailableError(this.reason);
  }
}
