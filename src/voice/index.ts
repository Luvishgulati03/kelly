/**
 * Optional, local voice adapters for parent integrations (for example, a
 * dashboard voice worker). Nothing downloads models or calls a remote API.
 *
 * STT is enabled only when both whisperCppPath and whisperModelPath are set.
 * TTS is enabled only for an explicitly selected engine. Recommended Kokoro
 * uses {engine:"kokoro", url, token}; URL is loopback-only and token-required.
 * `espeak-ng` is a lightweight but robotic fallback selected explicitly via
 * {engine:"espeak-ng", executablePath}; Piper is opt-in and requires a model.
 * Hindi Piper model datasets can carry non-commercial terms, so callers must
 * choose and license-check their model themselves.
 *
 * API:
 *   const voice = new LocalVoiceService({
 *     stt: { whisperCppPath: "/opt/homebrew/bin/whisper-cli", whisperModelPath: "/models/ggml-small-q5_1.bin" },
 *     tts: { engine: "kokoro", url: process.env.KELLY_KOKORO_URL, token: process.env.KELLY_KOKORO_TOKEN },
 *   });
 *   const { text, language } = await voice.transcribe(wavBytes, { language: "hi" });
 *   const wavBytes = await voice.synthesize(text, { language: "hi" });
 *
 * Use voiceConfigFromEnv() to map KELLY_WHISPER_CPP_PATH,
 * KELLY_WHISPER_MODEL_PATH, KELLY_KOKORO_URL and KELLY_KOKORO_TOKEN.
 * Text is passed through verbatim: no translation, script conversion, or
 * number/quantity normalization is performed. Inputs and outputs are WAV.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** String at the adapter boundary because callers receive language labels at runtime; validated per operation. */
export type VoiceLanguage = string;
export type TtsEngine = "espeak-ng" | "piper";

export interface SttConfig {
  /** Absolute or PATH-resolved whisper.cpp-compatible executable. */
  whisperCppPath?: string;
  /** Required multilingual ggml model path; Hindi needs a multilingual model. */
  whisperModelPath?: string;
  timeoutMs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
}

export interface TtsConfig {
  /** Explicit executable; no PATH probing or implicit engine selection. */
  executablePath?: string;
  engine?: TtsEngine | "kokoro";
  /** Kokoro server base URL (loopback HTTP only). */
  url?: string;
  /** Required bearer token for the local Kokoro worker. */
  token?: string;
  /** Required for Piper; ignored by espeak-ng. */
  modelPath?: string;
  timeoutMs?: number;
  maxInputChars?: number;
  maxOutputBytes?: number;
}

export interface VoiceConfig {
  stt?: SttConfig;
  tts?: TtsConfig;
  tempRoot?: string;
}

export interface VoiceRunOptions {
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  /** Passed as data over stdin by Piper/eSpeak; never interpreted by a shell. */
  stdin?: string;
  /** Optional streamed-to-file output cap for tools that write WAV/text to a file. */
  maxFilePath?: string;
  maxFileBytes?: number;
}

export interface VoiceCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
}

export type VoiceCommandRunner = (
  executable: string,
  args: string[],
  options: VoiceRunOptions,
) => Promise<VoiceCommandResult>;

export interface TranscriptionOptions {
  language?: VoiceLanguage;
  /** Vocabulary hint passed to whisper.cpp's --prompt; capped at 400 chars, newlines/quotes stripped. */
  prompt?: string;
}
export interface TranscriptionResult { text: string; language?: VoiceLanguage }
export interface SynthesisOptions { language?: VoiceLanguage }

export const VOICE_LIMITS = Object.freeze({
  sttInputBytes: 25 * 1024 * 1024,
  sttOutputBytes: 2 * 1024 * 1024,
  ttsInputChars: 10_000,
  ttsOutputBytes: 25 * 1024 * 1024,
  timeoutMs: 120_000,
  stderrBytes: 64 * 1024,
  kokoroResponseBytes: 25 * 1024 * 1024,
  sttInputSeconds: 5 * 60,
});

export class VoiceError extends Error {
  constructor(message: string, readonly code: "disabled" | "invalid_audio" | "too_large" | "timeout" | "provider" | "invalid_output") {
    super(message);
    this.name = "VoiceError";
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function validateWav(input: Buffer, maxBytes: number): void {
  if (input.length > maxBytes) throw new VoiceError(`WAV exceeds ${maxBytes} byte limit`, "too_large");
  if (input.length < 44 || input.toString("ascii", 0, 4) !== "RIFF" || input.toString("ascii", 8, 12) !== "WAVE") {
    throw new VoiceError("Expected a valid RIFF/WAVE audio file", "invalid_audio");
  }
  const declaredLength = input.readUInt32LE(4) + 8;
  if (declaredLength !== input.length) throw new VoiceError("Malformed WAV: RIFF length does not match input", "invalid_audio");
  let offset = 12;
  let format: number | undefined;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let byteRate: number | undefined;
  let blockAlign: number | undefined;
  let bitsPerSample: number | undefined;
  let dataLength: number | undefined;
  while (offset + 8 <= input.length) {
    const name = input.toString("ascii", offset, offset + 4);
    const size = input.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (size > input.length - start) throw new VoiceError("Malformed WAV chunk length", "invalid_audio");
    if (name === "fmt ") {
      if (size < 16) throw new VoiceError("Malformed WAV format chunk", "invalid_audio");
      format = input.readUInt16LE(start);
      channels = input.readUInt16LE(start + 2);
      sampleRate = input.readUInt32LE(start + 4);
      byteRate = input.readUInt32LE(start + 8);
      blockAlign = input.readUInt16LE(start + 12);
      bitsPerSample = input.readUInt16LE(start + 14);
    } else if (name === "data") dataLength = size;
    offset = start + size + (size & 1);
  }
  if (format === undefined || channels === undefined || sampleRate === undefined || byteRate === undefined
    || blockAlign === undefined || bitsPerSample === undefined || dataLength === undefined) {
    throw new VoiceError("Malformed WAV: missing format or audio data", "invalid_audio");
  }
  if (format !== 1 && format !== 3) throw new VoiceError("Unsupported WAV encoding; expected PCM or IEEE float", "invalid_audio");
  if (channels < 1 || channels > 2) throw new VoiceError("Unsupported WAV channel count; expected mono or stereo", "invalid_audio");
  if (sampleRate < 8_000 || sampleRate > 96_000) throw new VoiceError("Unsupported WAV sample rate", "invalid_audio");
  const validBits = format === 1 ? [8, 16, 24, 32] : [32, 64];
  if (!validBits.includes(bitsPerSample)) throw new VoiceError("Unsupported WAV bit depth", "invalid_audio");
  const expectedBlockAlign = channels * Math.ceil(bitsPerSample / 8);
  if (blockAlign !== expectedBlockAlign || byteRate !== sampleRate * blockAlign || dataLength % blockAlign !== 0) {
    throw new VoiceError("Malformed WAV: inconsistent sample geometry", "invalid_audio");
  }
  if (dataLength / byteRate > VOICE_LIMITS.sttInputSeconds) {
    throw new VoiceError(`WAV exceeds ${VOICE_LIMITS.sttInputSeconds} second duration limit`, "too_large");
  }
}

/** Bounded subprocess runner. Never invokes a shell; kills on timeout or cap breach. */
export const runVoiceCommand: VoiceCommandRunner = (executable, args, options) => new Promise((resolve, reject) => {
  let child;
  try {
    child = spawn(executable, args, { shell: false, stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  } catch (error) {
    reject(new VoiceError(`Could not start local voice executable: ${String(error)}`, "provider"));
    return;
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let settled = false;
  let timedOut = false;
  let tooMuchOutput = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs);
  const fileMonitor = options.maxFilePath && options.maxFileBytes
    ? setInterval(() => {
      try {
        if (statSync(options.maxFilePath!).size > options.maxFileBytes!) {
          tooMuchOutput = true;
          child.kill("SIGKILL");
        }
      } catch { /* The output file may not exist yet. */ }
    }, 25)
    : undefined;
  const finishError = (error: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (fileMonitor) clearInterval(fileMonitor);
    reject(error);
  };
  child.stdout!.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > options.maxStdoutBytes) { tooMuchOutput = true; child.kill("SIGKILL"); return; }
    stdout.push(Buffer.from(chunk));
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    const room = options.maxStderrBytes - stderrBytes;
    if (room > 0) { const kept = chunk.subarray(0, room); stderr.push(Buffer.from(kept)); stderrBytes += kept.length; }
  });
  child.once("error", (error) => finishError(new VoiceError(`Could not start local voice executable: ${error.message}`, "provider")));
  child.once("close", (exitCode) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (fileMonitor) clearInterval(fileMonitor);
    if (timedOut) { reject(new VoiceError("Local voice executable timed out", "timeout")); return; }
    let fileTooLarge = false;
    if (options.maxFilePath && options.maxFileBytes) {
      try { fileTooLarge = statSync(options.maxFilePath).size > options.maxFileBytes; } catch { /* Caller validates required output presence. */ }
    }
    if (tooMuchOutput || fileTooLarge) { reject(new VoiceError("Local voice executable exceeded output limit", "too_large")); return; }
    // Do not trust the observed byte count as Buffer.concat's allocation size:
    // after a cap breach the child may still race data events before SIGKILL.
    resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr, stderrBytes), exitCode });
  });
  if (options.stdin !== undefined) {
    child.stdin!.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") finishError(new VoiceError(`Could not write to local voice executable: ${error.message}`, "provider"));
    });
    child.stdin!.end(options.stdin, "utf8");
  }
});

export class LocalVoiceService {
  constructor(
    private readonly config: VoiceConfig = {},
    private readonly runner: VoiceCommandRunner = runVoiceCommand,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  sttEnabled(): boolean { return Boolean(this.config.stt?.whisperCppPath && this.config.stt.whisperModelPath); }
  ttsEnabled(): boolean {
    const tts = this.config.tts;
    if (tts?.engine === "kokoro") return Boolean(tts.url && tts.token && isLoopbackHttpUrl(tts.url));
    if (tts?.engine !== "espeak-ng" && tts?.engine !== "piper") return false;
    return Boolean(tts?.executablePath && (tts.engine !== "piper" || tts.modelPath));
  }

  async transcribe(wav: Uint8Array, options: TranscriptionOptions = {}): Promise<TranscriptionResult> {
    assertLanguage(options.language, true);
    const cfg = this.config.stt;
    if (!cfg?.whisperCppPath || !cfg.whisperModelPath) throw new VoiceError("Local STT is disabled; configure whisperCppPath and whisperModelPath", "disabled");
    const audio = Buffer.from(wav);
    const maxInput = positiveInt(cfg.maxInputBytes, VOICE_LIMITS.sttInputBytes);
    validateWav(audio, maxInput);
    const maxOutput = positiveInt(cfg.maxOutputBytes, VOICE_LIMITS.sttOutputBytes);
    const dir = await mkdtemp(path.join(this.config.tempRoot ?? os.tmpdir(), "kelly-stt-"));
    try {
      const inputPath = path.join(dir, "input.wav");
      const outputPrefix = path.join(dir, "transcript");
      await writeFile(inputPath, audio, { mode: 0o600, flag: "wx" });
      const args = ["-m", cfg.whisperModelPath, "-f", inputPath, "--output-txt", "-of", outputPrefix];
      args.push("-l", options.language && options.language !== "hi-en" && options.language !== "auto" ? options.language : "auto");
      const prompt = options.prompt?.replace(/[\r\n]+/g, " ").replace(/["']/g, "").trim().slice(0, 400);
      if (prompt) args.push("--prompt", prompt);
      const result = await this.runner(cfg.whisperCppPath, args, {
        timeoutMs: positiveInt(cfg.timeoutMs, VOICE_LIMITS.timeoutMs),
        maxStdoutBytes: VOICE_LIMITS.stderrBytes,
        maxStderrBytes: VOICE_LIMITS.stderrBytes,
        maxFilePath: `${outputPrefix}.txt`,
        maxFileBytes: maxOutput,
      });
      if (result.exitCode !== 0) throw new VoiceError(`Local STT failed (exit ${result.exitCode}): ${result.stderr.toString("utf8").slice(0, 1000)}`, "provider");
      const transcriptPath = `${outputPrefix}.txt`;
      const info = await stat(transcriptPath).catch(() => undefined);
      if (!info || info.size > maxOutput) throw new VoiceError("Local STT output is missing or exceeds configured limit", info ? "too_large" : "invalid_output");
      const text = await readFile(transcriptPath, "utf8");
      if (!text.trim()) throw new VoiceError("Local STT returned an empty transcript", "invalid_output");
      return { text: text.trim(), ...(options.language ? { language: options.language } : {}) };
    } catch (error) {
      if (error instanceof VoiceError) throw error;
      throw new VoiceError(`Local STT failed: ${error instanceof Error ? error.message : String(error)}`, "provider");
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async synthesize(text: string, options: SynthesisOptions = {}): Promise<Buffer> {
    assertLanguage(options.language, true);
    const cfg = this.config.tts;
    if (cfg?.engine === "kokoro") return this.synthesizeWithKokoro(text, options, cfg);
    if (!cfg?.engine) throw new VoiceError("Local TTS is disabled; select an engine explicitly", "disabled");
    if (cfg?.engine !== undefined && cfg.engine !== "espeak-ng" && cfg.engine !== "piper") {
      throw new VoiceError(`Unsupported local TTS engine: ${String(cfg.engine)}`, "disabled");
    }
    if (!cfg?.executablePath || (cfg.engine === "piper" && !cfg.modelPath)) {
      throw new VoiceError("Local TTS is disabled; configure an executable and, for Piper, a modelPath", "disabled");
    }
    if (typeof text !== "string" || !text.trim()) throw new VoiceError("Text to synthesize must not be empty", "invalid_output");
    const maxChars = positiveInt(cfg.maxInputChars, VOICE_LIMITS.ttsInputChars);
    if (text.length > maxChars) throw new VoiceError(`Text exceeds ${maxChars} character limit`, "too_large");
    const maxOutput = positiveInt(cfg.maxOutputBytes, VOICE_LIMITS.ttsOutputBytes);
    const dir = await mkdtemp(path.join(this.config.tempRoot ?? os.tmpdir(), "kelly-tts-"));
    try {
      const outputPath = path.join(dir, `speech-${randomUUID()}.wav`);
      let args: string[];
      if (cfg.engine === "piper") {
        args = ["--model", cfg.modelPath!, "--output_file", outputPath];
      } else {
        const language = options.language === "auto" || options.language === "hi-en" || options.language === undefined
          ? inferTextLanguage(text) : options.language;
        args = ["-v", language, "-w", outputPath];
      }
      // stdin carries text as data; no shell parsing and no text transformation.
      const run = await this.runner(cfg.executablePath, args, {
          timeoutMs: positiveInt(cfg.timeoutMs, VOICE_LIMITS.timeoutMs),
          maxStdoutBytes: VOICE_LIMITS.stderrBytes,
          maxStderrBytes: VOICE_LIMITS.stderrBytes,
          stdin: text,
          maxFilePath: outputPath,
          maxFileBytes: maxOutput,
        });
      if (run.exitCode !== 0) throw new VoiceError(`Local TTS failed (exit ${run.exitCode}): ${run.stderr.toString("utf8").slice(0, 1000)}`, "provider");
      const info = await stat(outputPath).catch(() => undefined);
      if (!info || info.size > maxOutput) throw new VoiceError("Local TTS output is missing or exceeds configured limit", info ? "too_large" : "invalid_output");
      const audio = await readFile(outputPath);
      validateWav(audio, maxOutput);
      return audio;
    } catch (error) {
      if (error instanceof VoiceError) throw error;
      throw new VoiceError(`Local TTS failed: ${error instanceof Error ? error.message : String(error)}`, "provider");
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async synthesizeWithKokoro(text: string, options: SynthesisOptions, cfg: TtsConfig): Promise<Buffer> {
    if (!cfg.url || !cfg.token || !isLoopbackHttpUrl(cfg.url)) {
      throw new VoiceError("Kokoro requires a loopback http:// URL and bearer token", "disabled");
    }
    if (typeof text !== "string" || !text.trim()) throw new VoiceError("Text to synthesize must not be empty", "invalid_output");
    const maxChars = positiveInt(cfg.maxInputChars, VOICE_LIMITS.ttsInputChars);
    if (text.length > maxChars) throw new VoiceError(`Text exceeds ${maxChars} character limit`, "too_large");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), positiveInt(cfg.timeoutMs, VOICE_LIMITS.timeoutMs));
    try {
      const base = new URL(cfg.url);
      const endpoint = new URL("/synthesize", base);
      const response = await this.fetcher(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json", accept: "audio/wav" },
        body: JSON.stringify({
          text,
          language: options.language === "hi" || (options.language !== "en" && inferTextLanguage(text) === "hi") ? "hi" : "en",
        }),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) throw new VoiceError(`Kokoro worker returned HTTP ${response.status}`, "provider");
      const maxBytes = Math.min(positiveInt(cfg.maxOutputBytes, VOICE_LIMITS.ttsOutputBytes), VOICE_LIMITS.kokoroResponseBytes);
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > maxBytes) throw new VoiceError("Kokoro WAV exceeds configured output limit", "too_large");
      if (!response.body) throw new VoiceError("Kokoro worker returned an empty response", "invalid_output");
      const chunks: Buffer[] = [];
      let total = 0;
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel(); throw new VoiceError("Kokoro WAV exceeds configured output limit", "too_large"); }
        chunks.push(Buffer.from(value));
      }
      const audio = Buffer.concat(chunks, total);
      validateWav(audio, maxBytes);
      return audio;
    } catch (error) {
      if (error instanceof VoiceError) throw error;
      if (controller.signal.aborted) throw new VoiceError("Kokoro synthesis timed out", "timeout");
      throw new VoiceError(`Kokoro synthesis failed: ${error instanceof Error ? error.message : String(error)}`, "provider");
    } finally {
      clearTimeout(timer);
    }
  }
}

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
  } catch { return false; }
}

function assertLanguage(language: VoiceLanguage | undefined, allowMixed: boolean): void {
  if (language === undefined) return;
  if (language !== "hi" && language !== "en" && !(allowMixed && (language === "hi-en" || language === "auto"))) {
    throw new VoiceError(`Unsupported voice language: ${String(language)}`, "invalid_output");
  }
}

function inferTextLanguage(text: string): "hi" | "en" {
  return /[\u0900-\u097f]/u.test(text) ? "hi" : "en";
}

/** Read supported Kelly environment settings without making any engine implicit. */
export function voiceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const stt: SttConfig = {
    whisperCppPath: env.KELLY_WHISPER_CPP_PATH || undefined,
    whisperModelPath: env.KELLY_WHISPER_MODEL_PATH || undefined,
  };
  const requestedEngine = env.KELLY_TTS_ENGINE || (env.KELLY_KOKORO_URL ? "kokoro" : undefined);
  const tts: TtsConfig = {
    // Preserve invalid values for the service to reject; never turn a typo into eSpeak.
    engine: requestedEngine as TtsConfig["engine"],
    executablePath: env.KELLY_TTS_EXECUTABLE || undefined,
    modelPath: env.KELLY_TTS_MODEL_PATH || undefined,
    url: env.KELLY_KOKORO_URL || undefined,
    token: env.KELLY_KOKORO_TOKEN || undefined,
  };
  return {
    stt: stt.whisperCppPath || stt.whisperModelPath ? stt : undefined,
    tts: tts.engine || tts.executablePath || tts.url || tts.token ? tts : undefined,
  };
}
