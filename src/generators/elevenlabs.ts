import { ElevenLabsClient, ElevenLabsError } from "@elevenlabs/elevenlabs-js";
import { createWriteStream, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { randomUUID } from "node:crypto";
import { getCacheDir } from "../cache.js";
import {
  type GenerateOptions,
  type MusicGenerator,
  QuotaExceededError,
} from "./types.js";

export class ElevenLabsGenerator implements MusicGenerator {
  readonly name = "elevenlabs";
  private client: ElevenLabsClient;

  constructor(apiKey: string) {
    this.client = new ElevenLabsClient({ apiKey });
  }

  async init(): Promise<void> {
    // SDK client is constructed eagerly — no async init needed.
  }

  async shutdown(): Promise<void> {
    // Nothing to clean up.
  }

  async generateTrack(opts: GenerateOptions): Promise<string> {
    const cacheDir = getCacheDir(opts.mood, opts.instrumental);
    const filename = `${opts.mood}-${randomUUID().slice(0, 8)}.mp3`;
    const outputPath = join(cacheDir, filename);
    // Write to a .tmp sibling and rename on success. If the stream fails
    // mid-download, the partial file never has the .mp3 extension that
    // getCachedTracks scans for, so it can't poison the cache.
    const tmpPath = outputPath + ".tmp";

    // Build the prompt — if we have lyrics, include them in the prompt
    let prompt = opts.musicPrompt;
    if (!opts.instrumental && opts.lyrics) {
      prompt = `${opts.musicPrompt}\n\nLyrics:\n${opts.lyrics}`;
    }

    let response;
    try {
      response = await this.client.music.compose({
        prompt,
        outputFormat: "mp3_44100_192",
        forceInstrumental: opts.instrumental,
        musicLengthMs: 180_000, // 3 minutes
      });
    } catch (err) {
      if (isQuotaExceeded(err)) {
        throw new QuotaExceededError(
          "ElevenLabs credits exhausted — upgrade at elevenlabs.io/pricing. Music burns ~1,500 credits/min; Creator tier (161k/mo) ≈ 107 min/month is the practical minimum."
        );
      }
      throw err;
    }

    // response is a web ReadableStream<Uint8Array>. The SDK types it with the
    // DOM's ReadableStream, but Readable.fromWeb expects Node's `stream/web`
    // flavor — they're structurally identical, so we cast through the Node type.
    const nodeStream = Readable.fromWeb(
      response as unknown as NodeWebReadableStream<Uint8Array>
    );
    const fileStream = createWriteStream(tmpPath);
    try {
      await pipeline(nodeStream, fileStream);
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* already gone */ }
      throw err;
    }
    renameSync(tmpPath, outputPath);

    return outputPath;
  }
}

function isQuotaExceeded(err: unknown): boolean {
  if (!(err instanceof ElevenLabsError)) return false;
  // ElevenLabs returns 401 with detail.status === "quota_exceeded" when out
  // of credits, and sometimes 402 Payment Required. Be defensive about body
  // shape — some errors stringify the detail rather than nesting it.
  if (err.statusCode !== 401 && err.statusCode !== 402) return false;
  const body = err.body as any;
  const detailStatus = body?.detail?.status;
  if (detailStatus === "quota_exceeded") return true;
  const serialized = JSON.stringify(body ?? "").toLowerCase();
  return serialized.includes("quota_exceeded") || serialized.includes("not enough credits");
}
