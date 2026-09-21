import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFile = promisify(execFileCallback);
const repoRoot = process.cwd();
const cliEntry = path.join(repoRoot, "src/cli.ts");

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_PROFILE: "kelly", ...extra };
  for (const key of [
    "KELLY_WHISPER_CPP_PATH", "KELLY_WHISPER_MODEL_PATH", "KELLY_KOKORO_URL",
    "KELLY_KOKORO_TOKEN", "KELLY_KOKORO_MODEL_PATH", "KELLY_KOKORO_VOICES_PATH",
    "KELLY_VOICE_PYTHON", "KELLY_TTS_ENGINE", "KELLY_TTS_EXECUTABLE", "KELLY_TTS_MODEL_PATH",
  ]) env[key] = "";
  Object.assign(env, extra);
  return env;
}

async function cli(args: string[], env = cleanEnv()) {
  try {
    const result = await execFile(process.execPath, ["--import", "tsx/esm", cliEntry, ...args], { cwd: repoRoot, env, timeout: 15_000, maxBuffer: 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const result = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { code: result.code ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}

function wav(): Buffer {
  const data = Buffer.alloc(44);
  data.write("RIFF", 0); data.writeUInt32LE(36, 4); data.write("WAVE", 8);
  data.write("fmt ", 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22); data.writeUInt32LE(24_000, 24); data.writeUInt32LE(48_000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(0, 40);
  return data;
}

test("voice status is standalone and reports config without starting the agent runtime", async () => {
  const result = await cli(["voice", "status"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { transcription: "not configured", speech: "not configured" });
});

test("voice transcribe passes WAV and selected language to the configured local backend", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kelly-voice-cli-stt-"));
  try {
    const audioPath = path.join(dir, "input.wav");
    const fakeWhisper = path.join(dir, "whisper-cli");
    await fs.writeFile(audioPath, wav());
    await fs.writeFile(fakeWhisper, "#!/usr/bin/env node\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);\nfs.writeFileSync(args[args.indexOf('-of')+1]+'.txt','  2.5 sq mm wire chahiye \\n');\n", { mode: 0o755 });
    const result = await cli(["voice", "transcribe", audioPath, "--language", "hi"], cleanEnv({
      KELLY_WHISPER_CPP_PATH: fakeWhisper, KELLY_WHISPER_MODEL_PATH: path.join(dir, "small-q5_1.bin"),
    }));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "2.5 sq mm wire chahiye");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("voice speak fails locally when TTS is not configured and does not create the requested output", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kelly-voice-cli-tts-"));
  try {
    const out = path.join(dir, "speech.wav");
    const result = await cli(["voice", "speak", "Namaste", "dukaan", "--language", "hi", "--out", out]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Local TTS is disabled/);
    await assert.rejects(fs.access(out));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("voice serve rejects non-loopback URLs before spawning Python", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kelly-voice-cli-serve-"));
  try {
    const model = path.join(dir, "model.onnx");
    const voices = path.join(dir, "voices.bin");
    await fs.writeFile(model, "model fixture"); await fs.writeFile(voices, "voice fixture");
    const result = await cli(["voice", "serve"], cleanEnv({
      KELLY_KOKORO_MODEL_PATH: model,
      KELLY_KOKORO_VOICES_PATH: voices,
      KELLY_KOKORO_TOKEN: "test-token-with-more-than-24-chars",
      KELLY_KOKORO_URL: "http://192.168.1.10:8765",
      KELLY_VOICE_PYTHON: "/usr/bin/true",
    }));
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /loopback HTTP origin/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("voice serve invokes configured Python without downloading model files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kelly-voice-cli-serve-ok-"));
  try {
    const model = path.join(dir, "model.onnx");
    const voices = path.join(dir, "voices.bin");
    await fs.writeFile(model, "model fixture"); await fs.writeFile(voices, "voice fixture");
    const result = await cli(["voice", "serve"], cleanEnv({
      KELLY_KOKORO_MODEL_PATH: model,
      KELLY_KOKORO_VOICES_PATH: voices,
      KELLY_KOKORO_TOKEN: "test-token-with-more-than-24-chars",
      KELLY_KOKORO_URL: "http://127.0.0.1:8765",
      KELLY_VOICE_PYTHON: "/usr/bin/true",
    }));
    assert.equal(result.code, 0, result.stderr);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
