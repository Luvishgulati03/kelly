import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TelegramAudioMeta } from "./pump.ts";

/**
 * TELEGRAM VOICE INTAKE — owner voice notes, bounded, and never self-authorizing.
 *
 * The rails, in the order they bite:
 *
 * 1. NOT A DECISION. A transcript is content, never consent. This module returns text;
 *    it never acts on it. The bridge requires a separately TYPED confirmation before the
 *    words reach the brain, so a spoken "approve" or "send" can authorize nothing.
 * 2. OWNER FIRST. The bridge matches its own chat id before anything here is called, so an
 *    unknown chat never reaches metadata, download, conversion, transcription, or the log.
 * 3. BOUNDED TWICE. Declared duration and size are checked BEFORE the download, and the
 *    byte cap is enforced again WHILE downloading, because metadata is client-supplied.
 * 4. NO SECRETS, NO URLS. The bot token and the file URL it appears in are never returned,
 *    logged, or attached to an error. Errors carry a code and a plain sentence.
 * 5. INJECTED EDGES. Fetching and converting are interfaces; tests pass fakes and no test
 *    ever contacts Telegram. The concrete ffmpeg path is explicit, `shell: false`, timed
 *    out, size-capped, and cleans up its private temp directory.
 *
 * Doctrine rule 7: this file imports no Kelly module except the wire types it consumes.
 * The transcriber and the sender are injected by the runtime.
 */

export type VoiceIntakeCode =
  | "disabled"
  | "unsupported_media"
  | "too_large"
  | "too_long"
  | "download_failed"
  | "conversion_failed"
  | "transcription_failed";

export class VoiceIntakeError extends Error {
  constructor(message: string, readonly code: VoiceIntakeCode) {
    super(message);
    this.name = "VoiceIntakeError";
  }
}

/** Telegram file metadata, reduced to what intake needs. `filePath` is a server-side path, not a URL. */
export interface TelegramFileInfo { filePath: string; fileSize?: number }

/** The two Telegram calls intake makes. Injected so tests never touch the network. */
export interface TelegramFileFetcher {
  getFile(fileId: string): Promise<TelegramFileInfo>;
  /** Streams the file, aborting as soon as `maxBytes` is exceeded. */
  download(file: TelegramFileInfo, maxBytes: number): Promise<Buffer>;
}

/** Audio transcoding. Telegram voice notes are OGG/Opus; whisper.cpp wants 16 kHz mono PCM WAV. */
export interface AudioConverter {
  toWav16kMono(input: Buffer, sourceMime?: string): Promise<Buffer>;
  /** Opus for a Telegram voice reply. Optional: without it, replies stay text-only. */
  toOpusVoice?(wav: Buffer): Promise<Buffer>;
}

/** The transcription contract, satisfied structurally by LocalVoiceService. */
export interface VoiceTranscriber {
  sttEnabled(): boolean;
  transcribe(wav: Uint8Array, options?: { language?: string }): Promise<{ text: string; language?: string }>;
}

export interface VoiceIntakeLimits {
  /** Hard byte cap, enforced against metadata and again while downloading. */
  maxBytes: number;
  /** Hard duration cap in seconds, enforced against declared metadata. */
  maxSeconds: number;
  /** Transcription language hint passed straight through to the adapter. */
  language: string;
}

export const VOICE_INTAKE_DEFAULTS: Readonly<VoiceIntakeLimits> = Object.freeze({
  // Telegram voice notes are Opus and small; 20 MB is already an outlier, not a normal note.
  maxBytes: 20 * 1024 * 1024,
  // Five minutes matches the STT adapter's own duration ceiling.
  maxSeconds: 5 * 60,
  // Hindi, English and Roman Hinglish all arrive on this surface, so never pin one language.
  language: "auto",
});

/** Accepted inbound containers. Anything else is refused before a byte is fetched. */
const SUPPORTED_MIME = /^audio\/(ogg|opus|oga|mpeg|mp4|m4a|x-m4a|wav|x-wav|webm)$/i;

export interface VoiceIntakeDeps {
  fetcher: TelegramFileFetcher;
  converter: AudioConverter;
  transcriber: VoiceTranscriber;
  limits?: Partial<VoiceIntakeLimits>;
}

export interface VoiceIntakeResult {
  text: string;
  language?: string;
  /** Bytes actually downloaded, for the activity log. Never includes the file path or URL. */
  bytes: number;
  durationSeconds?: number;
}

export class TelegramVoiceIntake {
  private readonly limits: VoiceIntakeLimits;

  constructor(private readonly deps: VoiceIntakeDeps) {
    const supplied = deps.limits ?? {};
    this.limits = {
      maxBytes: positive(supplied.maxBytes, VOICE_INTAKE_DEFAULTS.maxBytes),
      maxSeconds: positive(supplied.maxSeconds, VOICE_INTAKE_DEFAULTS.maxSeconds),
      language: supplied.language?.trim() || VOICE_INTAKE_DEFAULTS.language,
    };
  }

  /** False when transcription is not configured; the bridge then declines voice notes politely. */
  get enabled(): boolean {
    try { return this.deps.transcriber.sttEnabled(); } catch { return false; }
  }

  /** Whether a spoken reply is possible at all. The bridge always keeps the text reply. */
  get canSpeak(): boolean {
    return typeof this.deps.converter.toOpusVoice === "function";
  }

  describeLimits(): VoiceIntakeLimits { return { ...this.limits }; }

  /**
   * Metadata check BEFORE any download. Returns the reason to refuse, or undefined to proceed.
   * Declared values come from the sender, so passing here is necessary but never sufficient.
   */
  screen(meta: TelegramAudioMeta): VoiceIntakeError | undefined {
    if (!meta.file_id || typeof meta.file_id !== "string") {
      return new VoiceIntakeError("That voice note arrived without a usable file reference.", "unsupported_media");
    }
    if (meta.mime_type && !SUPPORTED_MIME.test(meta.mime_type)) {
      return new VoiceIntakeError(`I cannot read ${meta.mime_type} audio.`, "unsupported_media");
    }
    if (typeof meta.file_size === "number" && meta.file_size > this.limits.maxBytes) {
      return new VoiceIntakeError(`That audio is larger than my ${mb(this.limits.maxBytes)} limit.`, "too_large");
    }
    if (typeof meta.duration === "number" && meta.duration > this.limits.maxSeconds) {
      return new VoiceIntakeError(`That audio is longer than my ${this.limits.maxSeconds} second limit.`, "too_long");
    }
    return undefined;
  }

  /**
   * Metadata screen, bounded download, conversion, transcription. Throws VoiceIntakeError with
   * a code the bridge can turn into one plain sentence. No stage leaks a token or a URL.
   */
  async transcribe(meta: TelegramAudioMeta): Promise<VoiceIntakeResult> {
    if (!this.enabled) {
      throw new VoiceIntakeError("Voice transcription is not configured on this machine.", "disabled");
    }
    const refusal = this.screen(meta);
    if (refusal) throw refusal;

    let file: TelegramFileInfo;
    try {
      file = await this.deps.fetcher.getFile(meta.file_id);
    } catch (error) {
      throw new VoiceIntakeError(`I could not reach that voice note (${reason(error)}).`, "download_failed");
    }
    // Telegram repeats the size here; trust it no more than the message's own claim.
    if (typeof file.fileSize === "number" && file.fileSize > this.limits.maxBytes) {
      throw new VoiceIntakeError(`That audio is larger than my ${mb(this.limits.maxBytes)} limit.`, "too_large");
    }

    let audio: Buffer;
    try {
      audio = await this.deps.fetcher.download(file, this.limits.maxBytes);
    } catch (error) {
      if (error instanceof VoiceIntakeError) throw error;
      throw new VoiceIntakeError(`I could not download that voice note (${reason(error)}).`, "download_failed");
    }
    if (audio.length === 0) throw new VoiceIntakeError("That voice note arrived empty.", "download_failed");
    if (audio.length > this.limits.maxBytes) {
      throw new VoiceIntakeError(`That audio is larger than my ${mb(this.limits.maxBytes)} limit.`, "too_large");
    }

    let wav: Buffer;
    try {
      wav = await this.deps.converter.toWav16kMono(audio, meta.mime_type);
    } catch (error) {
      throw new VoiceIntakeError(`I could not convert that audio (${reason(error)}).`, "conversion_failed");
    }

    try {
      const result = await this.deps.transcriber.transcribe(wav, { language: this.limits.language });
      const text = result.text.trim();
      if (!text) throw new VoiceIntakeError("I could not hear any words in that note.", "transcription_failed");
      return {
        text,
        ...(result.language ? { language: result.language } : {}),
        bytes: audio.length,
        ...(typeof meta.duration === "number" ? { durationSeconds: meta.duration } : {}),
      };
    } catch (error) {
      if (error instanceof VoiceIntakeError) throw error;
      throw new VoiceIntakeError(`I could not transcribe that note (${reason(error)}).`, "transcription_failed");
    }
  }

  /** WAV to Telegram's Opus voice format. Undefined when no encoder is wired. */
  async encodeReply(wav: Buffer): Promise<Buffer | undefined> {
    if (!this.deps.converter.toOpusVoice) return undefined;
    return await this.deps.converter.toOpusVoice(wav);
  }
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : fallback;
}

function mb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * One short, safe sentence fragment from an unknown error. Deliberately truncated and
 * stripped of anything URL-shaped, so a bot token cannot ride out inside a message.
 */
function reason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/https?:\/\/\S+/gi, "[url]").replace(/\s+/g, " ").trim().slice(0, 120) || "unknown error";
}

/* ------------------------------------------------------------------ *
 * Concrete edges. Each one is replaceable in tests by the interfaces above.
 * ------------------------------------------------------------------ */

/** Telegram's own caps: 20 MB for a bot download, and getFile returns a server-side path. */
const TELEGRAM_FILE_TIMEOUT_MS = 30_000;

/**
 * The real Telegram file API. The token appears only inside the request URL this function
 * builds; it is never returned, logged, or included in an error, and a failure names the
 * status code rather than the address it came from.
 */
export function httpTelegramFileFetcher(token: string, fetchImpl: typeof fetch = fetch): TelegramFileFetcher {
  const api = (method: string) => `https://api.telegram.org/bot${token}/${method}`;
  return {
    async getFile(fileId: string): Promise<TelegramFileInfo> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TELEGRAM_FILE_TIMEOUT_MS);
      try {
        const response = await fetchImpl(`${api("getFile")}?file_id=${encodeURIComponent(fileId)}`, {
          signal: controller.signal, redirect: "error",
        });
        if (!response.ok) throw new VoiceIntakeError(`Telegram refused the file lookup (HTTP ${response.status}).`, "download_failed");
        const payload = await response.json() as { ok?: boolean; result?: { file_path?: string; file_size?: number } };
        const filePath = payload?.result?.file_path;
        if (payload?.ok !== true || !filePath) throw new VoiceIntakeError("Telegram did not return a file path.", "download_failed");
        return { filePath, ...(typeof payload.result?.file_size === "number" ? { fileSize: payload.result.file_size } : {}) };
      } finally {
        clearTimeout(timer);
      }
    },
    async download(file: TelegramFileInfo, maxBytes: number): Promise<Buffer> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TELEGRAM_FILE_TIMEOUT_MS);
      try {
        // The file path comes from Telegram's own getFile response, never from the message.
        const response = await fetchImpl(
          `https://api.telegram.org/file/bot${token}/${file.filePath.split("/").map(encodeURIComponent).join("/")}`,
          { signal: controller.signal, redirect: "error" },
        );
        if (!response.ok) throw new VoiceIntakeError(`Telegram refused the download (HTTP ${response.status}).`, "download_failed");
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) {
          throw new VoiceIntakeError("That audio is larger than my download limit.", "too_large");
        }
        if (!response.body) throw new VoiceIntakeError("Telegram returned an empty download.", "download_failed");
        const chunks: Buffer[] = [];
        let total = 0;
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          // Stop paying for bytes the moment the cap is passed, rather than after the fact.
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new VoiceIntakeError("That audio is larger than my download limit.", "too_large");
          }
          chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks, total);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface FfmpegConverterOptions {
  /** Explicit executable path. Nothing is probed on PATH and nothing is ever installed. */
  executablePath: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  tempRoot?: string;
}

/**
 * ffmpeg transcoding, spawned with `shell: false`, a timeout, an output cap, and a private
 * temp directory that is always removed. Kelly never installs or downloads ffmpeg: the
 * operator names an existing executable, or voice stays off.
 */
export function ffmpegAudioConverter(options: FfmpegConverterOptions): AudioConverter {
  const timeoutMs = positive(options.timeoutMs, 60_000);
  const maxOutputBytes = positive(options.maxOutputBytes, 25 * 1024 * 1024);
  const run = async (input: Buffer, args: (inPath: string, outPath: string) => string[], outName: string): Promise<Buffer> => {
    const dir = await mkdtemp(path.join(options.tempRoot ?? os.tmpdir(), "kelly-tg-voice-"));
    try {
      const inPath = path.join(dir, "input.bin");
      const outPath = path.join(dir, outName);
      await writeFile(inPath, input, { mode: 0o600, flag: "wx" });
      await spawnBounded(options.executablePath, args(inPath, outPath), timeoutMs);
      const produced = await readFile(outPath);
      if (produced.length === 0) throw new Error("ffmpeg produced no audio");
      if (produced.length > maxOutputBytes) throw new Error("converted audio exceeded the output limit");
      return produced;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
  return {
    toWav16kMono: (input) => run(
      input,
      (inPath, outPath) => ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", inPath, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", outPath],
      "converted.wav",
    ),
    toOpusVoice: (wav) => run(
      wav,
      (inPath, outPath) => ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", inPath, "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k", "-f", "ogg", outPath],
      "reply.ogg",
    ),
  };
}

/** Spawns a bounded child with no shell and no inherited stdin. Rejects on timeout or nonzero exit. */
function spawnBounded(executable: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, args, { shell: false, stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      reject(new Error(`could not start the audio converter: ${String(error)}`));
      return;
    }
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 4_000) stderr += chunk.toString("utf8"); });
    child.once("error", (error) => { clearTimeout(timer); reject(new Error(`could not start the audio converter: ${error.message}`)); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) { reject(new Error("the audio converter timed out")); return; }
      if (code !== 0) { reject(new Error(`the audio converter exited ${String(code)}: ${stderr.trim().slice(0, 200)}`)); return; }
      resolve();
    });
  });
}

/**
 * Sends one Opus voice note to the owner's own chat. This is the same authority boundary as
 * the existing text reply: one configured chat id, supplied by the runtime, never by a
 * message. Returns false instead of throwing, so a failed voice reply can fall back to text.
 */
export async function sendTelegramVoiceNote(
  input: { token: string; chatId: string; audio: Buffer; caption?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_FILE_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append("chat_id", input.chatId);
    if (input.caption) form.append("caption", input.caption.slice(0, 1024));
    form.append("voice", new Blob([new Uint8Array(input.audio)], { type: "audio/ogg" }), "reply.ogg");
    const response = await fetchImpl(`https://api.telegram.org/bot${input.token}/sendVoice`, {
      method: "POST", body: form, signal: controller.signal, redirect: "error",
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SPOKEN REPLIES (opt-in).
 *
 * Kelly answers in text first, always. A voice reply is an extra, and it is attempted only
 * for a turn the owner actually spoke. It is best effort by construction: synthesis, Opus
 * encoding, or the send can each fail, and every failure resolves to `false` so the text
 * answer the owner already has stands on its own.
 *
 * Long answers are not spoken. A quotation table read aloud is slower and less useful than
 * reading it, and local synthesis costs roughly real time, so anything past the cap stays text.
 */
export interface VoiceReplyDeps {
  synthesize(text: string, options?: { language?: string }): Promise<Buffer>;
  /** WAV to Telegram's Opus voice format; the converter from this module satisfies it. */
  encode(wav: Buffer): Promise<Buffer | undefined>;
  send(audio: Buffer): Promise<boolean>;
  /** Answers longer than this are left as text only. */
  maxChars?: number;
}

export const VOICE_REPLY_MAX_CHARS = 600;

export function telegramVoiceReplier(deps: VoiceReplyDeps): (text: string) => Promise<boolean> {
  const maxChars = positive(deps.maxChars, VOICE_REPLY_MAX_CHARS);
  return async (text: string): Promise<boolean> => {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > maxChars) return false;
    try {
      // Telegram voice replies are always spoken in English (speakableSummary output is
      // English prose); pin the language rather than auto-detecting per reply.
      const wav = await deps.synthesize(trimmed, { language: "en" });
      const opus = await deps.encode(wav);
      if (!opus?.length) return false;
      return await deps.send(opus);
    } catch {
      // The text answer is already delivered; a failed voice reply is not worth an error.
      return false;
    }
  };
}
