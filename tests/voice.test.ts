import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LocalVoiceService,
  VoiceError,
  runVoiceCommand,
  voiceConfigFromEnv,
  type VoiceCommandRunner,
} from "../src/voice/index.ts";

function wav(): Buffer {
  const data = Buffer.alloc(46);
  data.write("RIFF", 0, "ascii"); data.writeUInt32LE(38, 4); data.write("WAVE", 8, "ascii");
  data.write("fmt ", 12, "ascii"); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22); data.writeUInt32LE(16_000, 24); data.writeUInt32LE(32_000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36, "ascii");
  data.writeUInt32LE(2, 40); data.writeInt16LE(0, 44);
  return data;
}

async function temp(): Promise<string> { return fs.mkdtemp(path.join(os.tmpdir(), "kelly-voice-test-")); }

test("voice adapters stay disabled without explicit local configuration", async () => {
  const service = new LocalVoiceService();
  assert.equal(service.sttEnabled(), false);
  assert.equal(service.ttsEnabled(), false);
  await assert.rejects(service.transcribe(wav()), (error: unknown) => error instanceof VoiceError && error.code === "disabled");
  await assert.rejects(service.synthesize("नमस्ते"), (error: unknown) => error instanceof VoiceError && error.code === "disabled");
});

test("STT rejects malformed and oversized WAV before invoking its runner", async () => {
  let calls = 0;
  const runner: VoiceCommandRunner = async () => { calls += 1; return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 }; };
  const service = new LocalVoiceService({ stt: { whisperCppPath: "/local/whisper", whisperModelPath: "/models/multilingual.ggml", maxInputBytes: 45 } }, runner);
  await assert.rejects(service.transcribe(Buffer.from("not wav")), (error: unknown) => error instanceof VoiceError && error.code === "invalid_audio");
  await assert.rejects(service.transcribe(wav()), (error: unknown) => error instanceof VoiceError && error.code === "too_large");
  for (const mutate of [
    (audio: Buffer) => audio.writeUInt16LE(0, 22),
    (audio: Buffer) => audio.writeUInt32LE(1, 24),
    (audio: Buffer) => audio.writeUInt16LE(3, 34),
    (audio: Buffer) => audio.writeUInt16LE(1, 32),
  ]) {
    const malformed = wav(); mutate(malformed);
    const geometryService = new LocalVoiceService({ stt: { whisperCppPath: "/local/whisper", whisperModelPath: "/models/multilingual.ggml" } }, runner);
    await assert.rejects(geometryService.transcribe(malformed), (error: unknown) => error instanceof VoiceError && error.code === "invalid_audio");
  }
  const seconds = 301;
  const longAudio = Buffer.alloc(44 + seconds * 8_000 * 2);
  longAudio.write("RIFF", 0, "ascii"); longAudio.writeUInt32LE(longAudio.length - 8, 4); longAudio.write("WAVE", 8, "ascii");
  longAudio.write("fmt ", 12, "ascii"); longAudio.writeUInt32LE(16, 16); longAudio.writeUInt16LE(1, 20);
  longAudio.writeUInt16LE(1, 22); longAudio.writeUInt32LE(8_000, 24); longAudio.writeUInt32LE(16_000, 28);
  longAudio.writeUInt16LE(2, 32); longAudio.writeUInt16LE(16, 34); longAudio.write("data", 36, "ascii");
  longAudio.writeUInt32LE(longAudio.length - 44, 40);
  await assert.rejects(
    new LocalVoiceService({ stt: { whisperCppPath: "/local/whisper", whisperModelPath: "/models/multilingual.ggml" } }, runner).transcribe(longAudio),
    (error: unknown) => error instanceof VoiceError && error.code === "too_large",
  );
  assert.equal(calls, 0);
});

test("production subprocess runner enforces timeout, pipe output cap, and file output cap", async () => {
  const common = { maxStdoutBytes: 16, maxStderrBytes: 16 };
  await assert.rejects(
    runVoiceCommand(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { ...common, timeoutMs: 30 }),
    (error: unknown) => error instanceof VoiceError && error.code === "timeout",
  );
  await assert.rejects(
    runVoiceCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000))"], { ...common, timeoutMs: 1000 }),
    (error: unknown) => error instanceof VoiceError && error.code === "too_large",
  );
  const tempRoot = await temp();
  const output = path.join(tempRoot, "bounded.txt");
  await assert.rejects(
    runVoiceCommand(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], 'x'.repeat(100000))", output], {
      ...common, timeoutMs: 1000, maxFilePath: output, maxFileBytes: 128,
    }),
    (error: unknown) => error instanceof VoiceError && error.code === "too_large",
  );
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("STT passes a temporary WAV and preserves Hindi/Hinglish script and quantities", async () => {
  const tempRoot = await temp();
  const transcript = "मोटर 2 HP, 1.5 sq mm wire — 3 नग; kal bhejna.";
  let argsSeen: string[] = [];
  const runner: VoiceCommandRunner = async (_exe, args) => {
    argsSeen = args;
    const prefix = args[args.indexOf("-of") + 1]!;
    await fs.writeFile(`${prefix}.txt`, transcript);
    assert.deepEqual(await fs.readFile(args[args.indexOf("-f") + 1]!), wav());
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
  };
  const service = new LocalVoiceService({ tempRoot, stt: { whisperCppPath: "/local/whisper", whisperModelPath: "/models/ggml-small.bin" } }, runner);
  assert.deepEqual(await service.transcribe(wav(), { language: "hi-en" }), { text: transcript, language: "hi-en" });
  assert.ok(argsSeen.includes("/models/ggml-small.bin"));
  assert.deepEqual(argsSeen.slice(argsSeen.indexOf("-l")), ["-l", "auto"], "Hindi-capable multilingual mode is explicit, never whisper's English default");
  await service.transcribe(wav());
  assert.deepEqual(argsSeen.slice(argsSeen.indexOf("-l")), ["-l", "auto"], "unspecified language still uses automatic multilingual detection");
  await assert.rejects(service.transcribe(wav(), { language: "fr" as "hi" }), /Unsupported voice language/);
  await assert.rejects(service.transcribe(wav(), { language: "translate" }), /Unsupported voice language/);
  assert.equal((await fs.readdir(tempRoot)).length, 0, "per-request temporary audio and transcript are cleaned up");
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("STT reports provider and transcript output failures and cleans temporary files", async () => {
  const tempRoot = await temp();
  const failing: VoiceCommandRunner = async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.from("model load failed"), exitCode: 2 });
  const service = new LocalVoiceService({ tempRoot, stt: { whisperCppPath: "whisper", whisperModelPath: "model" } }, failing);
  await assert.rejects(service.transcribe(wav()), /Local STT failed \(exit 2\): model load failed/);
  assert.deepEqual(await fs.readdir(tempRoot), []);
  const empty: VoiceCommandRunner = async (_exe, args) => {
    await fs.writeFile(`${args[args.indexOf("-of") + 1]}.txt`, "  ");
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
  };
  await assert.rejects(new LocalVoiceService({ tempRoot, stt: { whisperCppPath: "whisper", whisperModelPath: "model" } }, empty).transcribe(wav()), /empty transcript/);
  assert.deepEqual(await fs.readdir(tempRoot), []);
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("eSpeak TTS is explicit, bounded, and receives original Unicode text over stdin", async () => {
  const tempRoot = await temp();
  const utterance = "₹1,250 के 2 मोटर — 1.5 sq mm; same quantity pls";
  let stdin = "";
  const runner: VoiceCommandRunner = async (_exe, args, options) => {
    stdin = options.stdin ?? "";
    const output = args[args.indexOf("-w") + 1]!;
    await fs.writeFile(output, wav());
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
  };
  const service = new LocalVoiceService({ tempRoot, tts: { engine: "espeak-ng", executablePath: "/usr/bin/espeak-ng" } }, runner);
  assert.equal(service.ttsEnabled(), true);
  assert.deepEqual(await service.synthesize(utterance, { language: "hi" }), wav());
  assert.equal(stdin, utterance);
  await assert.rejects(service.synthesize("x".repeat(10_001)), /character limit/);
  assert.deepEqual(await fs.readdir(tempRoot), []);
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("Kokoro uses authenticated loopback API, preserves text, and validates bounded WAV output", async () => {
  const utterance = "नमस्ते — 2 pcs, ₹1,250. Hinglish okay?";
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    requestUrl = String(input); requestInit = init;
    return new Response(new Uint8Array(wav()), { status: 200, headers: { "content-type": "audio/wav" } });
  };
  const service = new LocalVoiceService({ tts: { engine: "kokoro", url: "http://127.0.0.1:8765", token: "test-token" } }, undefined, fetcher);
  assert.equal(service.ttsEnabled(), true);
  assert.deepEqual(await service.synthesize(utterance, { language: "hi" }), wav());
  assert.equal(requestUrl, "http://127.0.0.1:8765/synthesize");
  const headers = new Headers(requestInit?.headers);
  assert.equal(headers.get("authorization"), "Bearer test-token");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), { text: utterance, language: "hi" });
  assert.equal(requestInit?.redirect, "error", "never forward bearer credentials through a redirect");
  await service.synthesize(utterance, { language: "hi-en" });
  assert.deepEqual(JSON.parse(String(requestInit?.body)), { text: utterance, language: "hi" });
  await service.synthesize("Motor 2 HP, 1.5 sq mm", { language: "auto" });
  assert.deepEqual(JSON.parse(String(requestInit?.body)), { text: "Motor 2 HP, 1.5 sq mm", language: "en" });

  const remote = new LocalVoiceService({ tts: { engine: "kokoro", url: "http://example.com", token: "x" } }, undefined, fetcher);
  assert.equal(remote.ttsEnabled(), false);
  await assert.rejects(remote.synthesize("hello"), /loopback/);
});

test("Kokoro handles provider failure, invalid WAV and response-size cap", async () => {
  const config = { tts: { engine: "kokoro" as const, url: "http://localhost:9000", token: "token", maxOutputBytes: 45 } };
  const tooLargeFetch: typeof fetch = async () => new Response(new Uint8Array(wav()), { status: 200 });
  await assert.rejects(new LocalVoiceService(config, undefined, tooLargeFetch).synthesize("hello"), /output limit/);
  const failureFetch: typeof fetch = async () => new Response("failed", { status: 503 });
  await assert.rejects(new LocalVoiceService(config, undefined, failureFetch).synthesize("hello"), /HTTP 503/);
  const invalidFetch: typeof fetch = async () => new Response(Buffer.from("bad"), { status: 200 });
  await assert.rejects(new LocalVoiceService({ tts: { ...config.tts, maxOutputBytes: 1024 } }, undefined, invalidFetch).synthesize("hello"), /RIFF\/WAVE/);
});

test("voice env adapter enables Kokoro only from URL plus token and never picks fallback silently", async () => {
  assert.deepEqual(voiceConfigFromEnv({}), { stt: undefined, tts: undefined });
  const config = voiceConfigFromEnv({ KELLY_KOKORO_URL: "http://127.0.0.1:8765", KELLY_KOKORO_TOKEN: "secret" });
  const service = new LocalVoiceService(config);
  assert.equal(service.ttsEnabled(), true);
  assert.equal(voiceConfigFromEnv({ KELLY_KOKORO_URL: "http://localhost:8765" }).tts?.engine, "kokoro");
  assert.equal(new LocalVoiceService(voiceConfigFromEnv({ KELLY_TTS_ENGINE: "espeak-ng", KELLY_TTS_EXECUTABLE: "/bin/espeak-ng" })).ttsEnabled(), true);
  const badEngine = new LocalVoiceService({ tts: { engine: "typo" as "espeak-ng", executablePath: "/bin/espeak-ng" } });
  assert.equal(badEngine.ttsEnabled(), false);
  await assert.rejects(badEngine.synthesize("hello"), /Unsupported local TTS engine/);
  const implicitEngine = new LocalVoiceService({ tts: { executablePath: "/bin/espeak-ng" } });
  assert.equal(implicitEngine.ttsEnabled(), false);
  await assert.rejects(implicitEngine.synthesize("hello"), /disabled/);
});
