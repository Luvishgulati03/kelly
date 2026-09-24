import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { HenryRuntime } from "../src/runtime.ts";
import { startDashboard } from "../src/dashboard/server.ts";
import { createUser, resetLoginThrottleForTests } from "../src/dashboard/auth.ts";
import { readVoiceSettings, updateVoiceSettings, VOICE_SETTINGS_DEFAULTS } from "../src/voice/transcripts.ts";
import type { RunOptions } from "../src/providers/runner.ts";
import { splitSentences } from "../src/voice/speakable.ts";

/**
 * CONVERSATIONAL COUNTER (backend), off by default.
 *
 * Covers: `voice.counterMode` settings (default/validation/env override), the `/counter`
 * route and its conversation-mode redirect from `/voice`, the early `spoken` SSE event
 * (fence-first, and the no-fence fallback), chunked `/api/voice/speak` framing, and the
 * `voice.tts` / `voice.tts.warm` activity events feeding `summarizeUsage`.
 */

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/* ------------------------------------------------------------------ *
 * 1. Settings: default, validation, env override — no server needed
 * ------------------------------------------------------------------ */

test("voice.counterMode defaults to review, validates input, and KELLY_COUNTER_MODE overrides a valid read", () => {
  const root = tempDir("kelly-counter-settings-");
  const settingsPath = path.join(root, "settings.json");

  assert.equal(readVoiceSettings(settingsPath).counterMode, "review");
  assert.equal(VOICE_SETTINGS_DEFAULTS.counterMode, "review");

  const updated = updateVoiceSettings(settingsPath, { counterMode: "conversation" });
  assert.equal(updated.counterMode, "conversation");
  assert.equal(readVoiceSettings(settingsPath).counterMode, "conversation", "persisted through settings.json");

  // Invalid input is ignored, not stored.
  const rejected = updateVoiceSettings(settingsPath, { counterMode: "loud" as unknown as "conversation" });
  assert.equal(rejected.counterMode, "conversation", "an invalid patch value leaves the persisted mode untouched");

  // A valid env override wins over whatever is persisted, for this read only.
  assert.equal(readVoiceSettings(settingsPath, { KELLY_COUNTER_MODE: "review" }).counterMode, "review");
  // An invalid env override is ignored; the persisted value applies.
  assert.equal(readVoiceSettings(settingsPath, { KELLY_COUNTER_MODE: "loud" }).counterMode, "conversation");
  // The override never gets baked into what a later save persists.
  const savedWithOverrideActive = updateVoiceSettings(settingsPath, { retentionDays: 45 });
  assert.equal(savedWithOverrideActive.counterMode, "conversation");
  const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { voice: { counterMode: string } };
  assert.equal(raw.voice.counterMode, "conversation");
});

test("voice.counterTier defaults to auto, validates input, and KELLY_COUNTER_TIER overrides a valid read", () => {
  const root = tempDir("kelly-counter-tier-settings-");
  const settingsPath = path.join(root, "settings.json");

  assert.equal(readVoiceSettings(settingsPath).counterTier, "auto");
  assert.equal(VOICE_SETTINGS_DEFAULTS.counterTier, "auto");

  const updated = updateVoiceSettings(settingsPath, { counterTier: "t0" });
  assert.equal(updated.counterTier, "t0");
  assert.equal(readVoiceSettings(settingsPath).counterTier, "t0", "persisted through settings.json");

  // Invalid input is ignored, not stored.
  const rejected = updateVoiceSettings(settingsPath, { counterTier: "t9" as unknown as "t0" });
  assert.equal(rejected.counterTier, "t0", "an invalid patch value leaves the persisted tier untouched");

  // A valid env override wins over whatever is persisted, for this read only.
  assert.equal(readVoiceSettings(settingsPath, { KELLY_COUNTER_TIER: "t1" }).counterTier, "t1");
  // An invalid env override is ignored; the persisted value applies.
  assert.equal(readVoiceSettings(settingsPath, { KELLY_COUNTER_TIER: "t9" }).counterTier, "t0");
  // The override never gets baked into what a later save persists.
  const savedWithOverrideActive = updateVoiceSettings(settingsPath, { retentionDays: 45 });
  assert.equal(savedWithOverrideActive.counterTier, "t0");
  const raw2 = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { voice: { counterTier: string } };
  assert.equal(raw2.voice.counterTier, "t0");
});

/* ------------------------------------------------------------------ *
 * 2. /counter and the conversation-mode redirect, by role
 * ------------------------------------------------------------------ */

async function withRoleDashboard(run: (base: string, runtime: HenryRuntime) => Promise<void>): Promise<void> {
  const tempRoot = tempDir("kelly-counter-role-");
  const previousDataDir = process.env.HENRY_DATA_DIR;
  process.env.HENRY_DATA_DIR = path.join(tempRoot, "data");
  resetLoginThrottleForTests();
  const runtime = await HenryRuntime.create(tempRoot);
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";
  createUser({ username: "owner", password: "owner-password-1", role: "admin" });
  createUser({ username: "counter", password: "counter-password-1", role: "counter" });
  const server = startDashboard(runtime);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`, runtime);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    runtime.close();
    resetLoginThrottleForTests();
    if (previousDataDir === undefined) delete process.env.HENRY_DATA_DIR;
    else process.env.HENRY_DATA_DIR = previousDataDir;
  }
}

async function login(base: string, username: string, password: string): Promise<string> {
  const response = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }).toString(),
    redirect: "manual",
  });
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "login should set a session cookie");
  return setCookie!.split(";")[0];
}

test("/counter serves the shop name and is reachable by the counter role", async () => {
  await withRoleDashboard(async (base, runtime) => {
    const cookie = await login(base, "counter", "counter-password-1");
    const page = await fetch(`${base}/counter`, { headers: { cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, new RegExp(runtime.config.shopName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(html, /<!--KELLY_SHOP-->/);
  });
});

test("conversation mode redirects a counter-role GET /voice to /counter; admins keep both", async () => {
  await withRoleDashboard(async (base, runtime) => {
    updateVoiceSettings(runtime.config.settingsPath, { counterMode: "conversation" });

    const counterCookie = await login(base, "counter", "counter-password-1");
    const counterVoice = await fetch(`${base}/voice`, { headers: { cookie: counterCookie }, redirect: "manual" });
    assert.equal(counterVoice.status, 302);
    assert.equal(counterVoice.headers.get("location"), "/counter");
    const counterCounter = await fetch(`${base}/counter`, { headers: { cookie: counterCookie } });
    assert.equal(counterCounter.status, 200);

    const adminCookie = await login(base, "owner", "owner-password-1");
    const adminVoice = await fetch(`${base}/voice`, { headers: { cookie: adminCookie }, redirect: "manual" });
    assert.equal(adminVoice.status, 200, "admins are never redirected off /voice");
    const adminCounter = await fetch(`${base}/counter`, { headers: { cookie: adminCookie } });
    assert.equal(adminCounter.status, 200, "admins can also open /counter");

    // Review mode (the default): /counter still serves, for testing the page before flipping the flag.
    updateVoiceSettings(runtime.config.settingsPath, { counterMode: "review" });
    const reviewCounterVoice = await fetch(`${base}/voice`, { headers: { cookie: counterCookie }, redirect: "manual" });
    assert.equal(reviewCounterVoice.status, 200, "review mode never redirects /voice");
    const reviewCounter = await fetch(`${base}/counter`, { headers: { cookie: counterCookie } });
    assert.equal(reviewCounter.status, 200);

    const status = await fetch(`${base}/api/voice/status`, { headers: { cookie: counterCookie } }).then((r) => r.json()) as { counterMode: string };
    assert.equal(status.counterMode, "review", "every role can read counterMode off /api/voice/status");
  });
});

/* ------------------------------------------------------------------ *
 * 3. Early `spoken` SSE event, chunked speech, and TTS timing/usage
 * ------------------------------------------------------------------ */

function wav(): Buffer {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(36, 4); bytes.write("WAVE", 8); bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24); bytes.writeUInt32LE(32_000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(0, 40);
  return bytes;
}

/** A tiny fake `espeak-ng`-shaped executable: ignores its input, writes a minimal valid WAV
 *  to the path following `-w`. Exercises the real `/api/voice/speak` route end to end without
 *  needing a real TTS engine installed. */
function writeFakeSynth(dir: string): string {
  const scriptPath = path.join(dir, "fake-espeak.mjs");
  fs.writeFileSync(scriptPath, [
    "#!/usr/bin/env node",
    "import fs from 'node:fs';",
    "const args = process.argv.slice(2);",
    "const outPath = args[args.indexOf('-w') + 1];",
    `const bytes = Buffer.from(${JSON.stringify(wav().toString("base64"))}, 'base64');`,
    "fs.writeFileSync(outPath, bytes);",
  ].join("\n"), { mode: 0o755 });
  return scriptPath;
}

async function withVoiceDashboard(
  run: (base: string, runtime: HenryRuntime) => Promise<void>,
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<void> {
  const envKeys = ["KELLY_WHISPER_CPP_PATH", "KELLY_WHISPER_MODEL_PATH", "KELLY_TTS_ENGINE", "KELLY_TTS_EXECUTABLE", "KELLY_TTS_MODEL_PATH", "KELLY_KOKORO_URL", "KELLY_KOKORO_TOKEN"];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  for (const [key, value] of Object.entries(envOverrides)) if (value !== undefined) process.env[key] = value;
  const tempRoot = tempDir("kelly-counter-voice-");
  const runtime = await HenryRuntime.create(tempRoot);
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";
  runtime.config.dashboardToken = "counter-voice-test-token";
  fs.mkdirSync(path.dirname(runtime.config.settingsPath), { recursive: true });
  fs.writeFileSync(runtime.config.settingsPath, JSON.stringify({ "dashboard.auth.localAdminBypass": false }));
  const server = startDashboard(runtime);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`, runtime);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    runtime.close();
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

/** Parses an SSE response body into `[event, data]` pairs, in stream order. */
function parseSse(stream: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  const blocks = stream.split("\n\n").filter((block) => block.trim());
  for (const block of blocks) {
    const eventLine = block.split("\n").find((line) => line.startsWith("event:"));
    const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
    if (!eventLine || !dataLine) continue;
    events.push({ event: eventLine.slice("event:".length).trim(), data: JSON.parse(dataLine.slice("data:".length).trim()) });
  }
  return events;
}

type FakeOnEvent = (event: { parsed?: { text?: string } }) => void;

test("chat/send emits an early spoken SSE event once the leading ```spoken fence closes, stripped from token/done text", async () => {
  await withVoiceDashboard(async (base, runtime) => {
    const auth = { authorization: "Bearer counter-voice-test-token" };
    (runtime.agent as unknown as { run: unknown }).run = async (_prompt: string, options?: { onEvent?: FakeOnEvent }) => {
      const onEvent = options?.onEvent;
      onEvent?.({ parsed: { text: "```spoken\n" } });
      onEvent?.({ parsed: { text: "Got two suits. Total 100 rupees.\n" } });
      onEvent?.({ parsed: { text: "```\n\nTwo suits with lining, grand total 100 rupees.\n" } });
      return {
        runId: "early-spoken", provider: "codex", exitCode: 0, durationMs: 1, events: [],
        response: "```spoken\nGot two suits. Total 100 rupees.\n```\n\nTwo suits with lining, grand total 100 rupees.",
      };
    };

    const response = await fetch(`${base}/api/chat/send`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "two suits with lining", voice: true }),
    });
    assert.equal(response.status, 200);
    const events = parseSse(await response.text());
    const kinds = events.map((e) => e.event);

    // The spoken event fires as soon as the fence closes, before the rest of the reply (the
    // "after the fence" text) is shown as a token — and well before `done`.
    const spokenIndex = kinds.indexOf("spoken");
    const firstTokenAfterFenceIndex = kinds.findIndex((k, i) => k === "token" && i > 0 && (events[i].data as { text: string }).text.includes("Two suits with lining"));
    assert.notEqual(spokenIndex, -1, "a spoken event should have been emitted");
    assert.ok(spokenIndex < firstTokenAfterFenceIndex, "spoken fires before the post-fence text is shown as a token");
    assert.ok(spokenIndex < kinds.indexOf("done"), "spoken fires before done");

    const spokenPayload = events[spokenIndex].data as { text: string };
    assert.equal(spokenPayload.text, "Got two suits. Total 100 rupees.");

    // None of the fence's own characters ever reach a visible token.
    for (const e of events) if (e.event === "token") assert.doesNotMatch((e.data as { text: string }).text, /```spoken|```/);

    const done = events[events.length - 1];
    assert.equal(done.event, "done");
    assert.doesNotMatch((done.data as { response: string }).response, /```spoken/);

    assert.deepEqual(kinds, ["spoken", "token", "done"], "exact SSE event order for a reply that opens with the fence");
  });
});

test("chat/send forwards only Codex item.completed agent_message text, ignoring reasoning/command events, with per-message fence detection", async () => {
  await withVoiceDashboard(async (base, runtime) => {
    const auth = { authorization: "Bearer counter-voice-test-token" };
    (runtime.agent as unknown as { run: unknown }).run = async (
      _prompt: string,
      options?: { onEvent?: (event: { parsed?: Record<string, unknown> }) => void },
    ) => {
      const onEvent = options?.onEvent;
      // Reasoning: never a token.
      onEvent?.({ parsed: { type: "item.completed", item: { type: "reasoning", text: "Thinking about the rate card." } } });
      // First agent_message: commentary, no fence, forwarded as-is.
      onEvent?.({ parsed: { type: "item.started", item: { type: "agent_message", text: "" } } });
      onEvent?.({ parsed: { type: "item.completed", item: { type: "agent_message", text: "Checking the rate card." } } });
      // Command execution: never a token, even though it carries a `text` field.
      onEvent?.({ parsed: { type: "item.completed", item: { type: "command_execution", command: "cat rates.json", text: "500 per unit" } } });
      // Final agent_message: opens with the ```spoken fence after earlier commentary already streamed.
      onEvent?.({
        parsed: {
          type: "item.completed",
          item: { type: "agent_message", text: "```spoken\nRate card checked.\n```\nThe rate is 500 rupees per unit." },
        },
      });
      return {
        runId: "codex-shaped", provider: "codex", exitCode: 0, durationMs: 1, events: [],
        response: "Checking the rate card.\n\nThe rate is 500 rupees per unit.",
      };
    };

    const response = await fetch(`${base}/api/chat/send`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "what's the rate card", voice: true }),
    });
    assert.equal(response.status, 200);
    const events = parseSse(await response.text());
    const kinds = events.map((e) => e.event);

    // No reasoning or command_execution text ever reaches a token event.
    for (const e of events) {
      if (e.event !== "token") continue;
      const text = (e.data as { text: string }).text;
      assert.doesNotMatch(text, /Thinking about the rate card/);
      assert.doesNotMatch(text, /500 per unit/);
      assert.doesNotMatch(text, /cat rates\.json/);
    }

    const commentaryIndex = kinds.findIndex((k, i) => k === "token" && (events[i].data as { text: string }).text.includes("Checking the rate card"));
    const spokenIndex = kinds.indexOf("spoken");
    const answerIndex = kinds.findIndex((k, i) => k === "token" && (events[i].data as { text: string }).text.includes("The rate is 500 rupees per unit"));
    const doneIndex = kinds.indexOf("done");

    assert.notEqual(commentaryIndex, -1, "commentary agent_message should stream as a token");
    assert.notEqual(spokenIndex, -1, "the fence in the final agent_message should still produce a spoken event");
    assert.notEqual(answerIndex, -1, "the post-fence answer should stream as a token");
    assert.ok(commentaryIndex < spokenIndex, "commentary token arrives before the fence in the final message resolves");
    assert.ok(spokenIndex < answerIndex, "spoken fires before the post-fence answer token");
    assert.ok(answerIndex < doneIndex, "answer token arrives before done");

    const spokenPayload = events[spokenIndex].data as { text: string };
    assert.equal(spokenPayload.text, "Rate card checked.");

    for (const e of events) if (e.event === "token") assert.doesNotMatch((e.data as { text: string }).text, /```spoken|```/);

    const done = events[doneIndex].data as { response: string };
    assert.equal(done.response, "Checking the rate card.\n\nThe rate is 500 rupees per unit.");
    assert.doesNotMatch(done.response, /```spoken/);
  });
});

test("chat/send falls back to plain token streaming when a voice reply does not open with the fence", async () => {
  await withVoiceDashboard(async (base, runtime) => {
    const auth = { authorization: "Bearer counter-voice-test-token" };
    (runtime.agent as unknown as { run: unknown }).run = async (_prompt: string, options?: { onEvent?: FakeOnEvent }) => {
      const onEvent = options?.onEvent;
      onEvent?.({ parsed: { text: "Sure, here is the answer.\n" } });
      return { runId: "no-fence", provider: "codex", exitCode: 0, durationMs: 1, events: [], response: "Sure, here is the answer." };
    };

    const response = await fetch(`${base}/api/chat/send`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello", voice: true }),
    });
    assert.equal(response.status, 200);
    const events = parseSse(await response.text());
    assert.ok(!events.some((e) => e.event === "spoken"), "no fence, so no early spoken event");
    assert.ok(events.some((e) => e.event === "token" && (e.data as { text: string }).text.includes("Sure, here is the answer")));
  });
});

/* ------------------------------------------------------------------ *
 * voice.counterTier forwarded (or not) as RunOptions.tier
 * ------------------------------------------------------------------ */

test("a voice turn with counterTier t0 passes tier:\"t0\" to the agent run; auto passes no tier; a non-voice turn never reads the setting", async () => {
  await withVoiceDashboard(async (base, runtime) => {
    const auth = { authorization: "Bearer counter-voice-test-token" };
    const seenOptions: RunOptions[] = [];
    (runtime.agent as unknown as { run: unknown }).run = async (_prompt: string, options?: RunOptions) => {
      seenOptions.push(options ?? {});
      return { runId: "tier-capture", provider: "codex", exitCode: 0, durationMs: 1, events: [], response: "```spoken\nOk.\n```\nOk." };
    };

    updateVoiceSettings(runtime.config.settingsPath, { counterTier: "t0" });
    await fetch(`${base}/api/chat/send`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "how much for two salwar suits with lining", voice: true }),
    }).then((r) => r.text());
    assert.equal(seenOptions.length, 1);
    assert.equal(seenOptions[0].tier, "t0", "a voice turn with counterTier t0 pins the run to tier t0");

    updateVoiceSettings(runtime.config.settingsPath, { counterTier: "auto" });
    await fetch(`${base}/api/chat/send`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "how much for two salwar suits with lining, take two", voice: true }),
    }).then((r) => r.text());
    assert.equal(seenOptions.length, 2);
    assert.equal(seenOptions[1].tier, undefined, "counterTier auto never sets a tier — routing is unchanged");

    updateVoiceSettings(runtime.config.settingsPath, { counterTier: "t1" });
    await fetch(`${base}/api/chat/send`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "how much for two salwar suits with lining, take three" }),
    }).then((r) => r.text());
    assert.equal(seenOptions.length, 3);
    assert.equal(seenOptions[2].tier, undefined, "a non-voice turn never reads voice.counterTier");
  });
});

/* ------------------------------------------------------------------ *
 * Chunked speech and TTS timing/usage
 * ------------------------------------------------------------------ */

test("POST /api/voice/speak with chunk:true frames N valid WAVs and records per-sentence voice.tts events", async () => {
  const dir = tempDir("kelly-fake-synth-");
  const synth = writeFakeSynth(dir);
  await withVoiceDashboard(async (base, runtime) => {
    const auth = { authorization: "Bearer counter-voice-test-token" };
    const text = "Hello there. How are you? Ready!";
    const sentences = splitSentences(text);
    assert.equal(sentences.length, 3);

    const response = await fetch(`${base}/api/voice/speak`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ text, chunk: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/x-kelly-wav-seq");
    const buf = Buffer.from(await response.arrayBuffer());

    const frames: Buffer[] = [];
    let offset = 0;
    while (offset < buf.length) {
      const len = buf.readUInt32BE(offset);
      offset += 4;
      frames.push(buf.subarray(offset, offset + len));
      offset += len;
    }
    assert.equal(frames.length, sentences.length, "one frame per sentence");
    for (const frame of frames) {
      assert.equal(frame.toString("ascii", 0, 4), "RIFF");
      assert.equal(frame.toString("ascii", 8, 12), "WAVE");
    }

    const events = await runtime.activity.list(50);
    const ttsEvents = events.filter((e) => e.kind === "voice.tts");
    assert.equal(ttsEvents.length, 3, "one voice.tts event per synthesised sentence");
    for (const e of ttsEvents) {
      assert.equal(e.metadata?.sentence, true);
      assert.equal(typeof e.metadata?.chars, "number");
      assert.equal(typeof e.metadata?.ms, "number");
    }

    const usage = await fetch(`${base}/api/usage`, { headers: auth }).then((r) => r.json()) as { voice: { ttsChars: number; ttsMs: number; ttsP50MsPer100Chars: number | null } };
    const expectedChars = sentences.reduce((n, s) => n + s.length, 0);
    assert.equal(usage.voice.ttsChars, expectedChars);
    assert.ok(usage.voice.ttsMs >= 0);
    assert.notEqual(usage.voice.ttsP50MsPer100Chars, null);
  }, { KELLY_TTS_ENGINE: "espeak-ng", KELLY_TTS_EXECUTABLE: synth });
});

test("a non-chunked speak call also records a single voice.tts event with sentence:false", async () => {
  const dir = tempDir("kelly-fake-synth-single-");
  const synth = writeFakeSynth(dir);
  await withVoiceDashboard(async (base, runtime) => {
    const auth = { authorization: "Bearer counter-voice-test-token" };
    const response = await fetch(`${base}/api/voice/speak`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ text: "Ready." }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/wav");
    const events = await runtime.activity.list(50);
    const ttsEvents = events.filter((e) => e.kind === "voice.tts");
    assert.equal(ttsEvents.length, 1);
    assert.equal(ttsEvents[0].metadata?.sentence, false);
  }, { KELLY_TTS_ENGINE: "espeak-ng", KELLY_TTS_EXECUTABLE: synth });
});

test("Kokoro warm-up synthesises once at startup and records voice.tts.warm, not voice.tts", async () => {
  const requests: string[] = [];
  const kokoro = http.createServer((request, response) => {
    requests.push(request.url || "");
    if (request.method === "POST" && request.url === "/synthesize") {
      response.writeHead(200, { "content-type": "audio/wav" });
      response.end(wav());
      return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>((resolve) => kokoro.listen(0, "127.0.0.1", resolve));
  const kokoroAddress = kokoro.address();
  assert.ok(kokoroAddress && typeof kokoroAddress !== "string");
  try {
    await withVoiceDashboard(async (_base, runtime) => {
      let warmEvent: unknown;
      for (let attempt = 0; attempt < 40 && !warmEvent; attempt += 1) {
        const events = await runtime.activity.list(50);
        warmEvent = events.find((e) => e.kind === "voice.tts.warm");
        if (!warmEvent) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(warmEvent, "voice.tts.warm should be recorded shortly after startup");
      assert.equal(typeof (warmEvent as { metadata?: { ms?: number } }).metadata?.ms, "number");
      const ttsEvents = (await runtime.activity.list(50)).filter((e) => e.kind === "voice.tts");
      assert.equal(ttsEvents.length, 0, "the warm-up synthesis is not counted as a real voice.tts call");
      assert.ok(requests.includes("/synthesize"));
    }, { KELLY_KOKORO_URL: `http://127.0.0.1:${kokoroAddress.port}`, KELLY_KOKORO_TOKEN: "warm-up-test-token" });
  } finally {
    await new Promise<void>((resolve) => kokoro.close(() => resolve()));
  }
});
