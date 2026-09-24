import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { HenryRuntime } from "../src/runtime.ts";
import { startDashboard } from "../src/dashboard/server.ts";
import { createUser, resetLoginThrottleForTests } from "../src/dashboard/auth.ts";
import { updateVoiceSettings, isCounterMode } from "../src/voice/transcripts.ts";
import { summarizeUsage } from "../src/dashboard/usage.ts";
import { tradePack } from "../src/trade/index.ts";

/**
 * KELLY TALK (backend), behind `voice.counterMode: "talk"`.
 *
 * Covers: the "talk" mode value, `/counter` and `/talk` routing across all three modes,
 * `GET /api/voice/greeting` / `.../reprompt` (synthesise-once, memory + disk cache, 404 when
 * TTS is disabled), `GET /vendor/vad/*` (allowlisted asset, traversal 404, counter-role GET
 * but not POST), and `POST /api/voice/talk/session` (journal events + summarizeUsage).
 */

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/* ------------------------------------------------------------------ *
 * 1. isCounterMode accepts "talk"
 * ------------------------------------------------------------------ */

test('isCounterMode accepts "talk" alongside "review" and "conversation"', () => {
  assert.equal(isCounterMode("talk"), true);
  assert.equal(isCounterMode("review"), true);
  assert.equal(isCounterMode("conversation"), true);
  assert.equal(isCounterMode("loud"), false);
});

/* ------------------------------------------------------------------ *
 * Shared server harness (mirrors tests/kelly-counter-mode.test.ts)
 * ------------------------------------------------------------------ */

function wav(): Buffer {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(36, 4); bytes.write("WAVE", 8); bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24); bytes.writeUInt32LE(32_000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(0, 40);
  return bytes;
}

/** A fake `espeak-ng`-shaped executable that counts its own invocations (via a counter file,
 *  since each call is a separate process) and writes a minimal valid WAV to `-w`'s path. */
function writeCountingFakeSynth(dir: string): { scriptPath: string; countPath: string } {
  const scriptPath = path.join(dir, "fake-espeak.mjs");
  const countPath = path.join(dir, "calls.count");
  fs.writeFileSync(countPath, "0");
  fs.writeFileSync(scriptPath, [
    "#!/usr/bin/env node",
    "import fs from 'node:fs';",
    `const countPath = ${JSON.stringify(countPath)};`,
    "fs.writeFileSync(countPath, String(Number(fs.readFileSync(countPath, 'utf8')) + 1));",
    "const args = process.argv.slice(2);",
    "const outPath = args[args.indexOf('-w') + 1];",
    `const bytes = Buffer.from(${JSON.stringify(wav().toString("base64"))}, 'base64');`,
    "fs.writeFileSync(outPath, bytes);",
  ].join("\n"), { mode: 0o755 });
  return { scriptPath, countPath };
}

async function withDashboard(
  run: (base: string, runtime: HenryRuntime) => Promise<void>,
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<void> {
  const envKeys = ["KELLY_WHISPER_CPP_PATH", "KELLY_WHISPER_MODEL_PATH", "KELLY_TTS_ENGINE", "KELLY_TTS_EXECUTABLE", "KELLY_TTS_MODEL_PATH", "KELLY_KOKORO_URL", "KELLY_KOKORO_TOKEN"];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  for (const [key, value] of Object.entries(envOverrides)) if (value !== undefined) process.env[key] = value;
  const tempRoot = tempDir("kelly-talk-");
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
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
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

/* ------------------------------------------------------------------ *
 * 2. /counter and /talk routing across all three modes
 * ------------------------------------------------------------------ */

test("GET /counter and /talk route by counterMode: review, conversation, talk", async () => {
  await withDashboard(async (base, runtime) => {
    const cookie = await login(base, "owner", "owner-password-1");

    const counterHtml = await fetch(`${base}/counter`, { headers: { cookie } }).then((r) => r.text());
    assert.match(counterHtml, /id="orbCanvas"|id="talk"|id="mute"/, "counter.html loaded (sanity)");

    // review + ?page=talk previews talk.html (has the KellyTalk testing hook script).
    const previewTalk = await fetch(`${base}/counter?page=talk`, { headers: { cookie } }).then((r) => r.text());
    assert.match(previewTalk, /KellyTalk/, "?page=talk previews talk.html even in review mode");

    // conversation: /counter serves counter.html (no KellyTalk global).
    updateVoiceSettings(runtime.config.settingsPath, { counterMode: "conversation" });
    const conversationCounter = await fetch(`${base}/counter`, { headers: { cookie } }).then((r) => r.text());
    assert.doesNotMatch(conversationCounter, /KellyTalk/, "conversation mode /counter is counter.html, not talk.html");

    // talk: /counter serves talk.html directly, no query needed.
    updateVoiceSettings(runtime.config.settingsPath, { counterMode: "talk" });
    const talkCounter = await fetch(`${base}/counter`, { headers: { cookie } }).then((r) => r.text());
    assert.match(talkCounter, /KellyTalk/, "talk mode /counter serves talk.html");

    // /talk is always talk.html, in every mode.
    updateVoiceSettings(runtime.config.settingsPath, { counterMode: "review" });
    const talkAlias = await fetch(`${base}/talk`, { headers: { cookie } }).then((r) => r.text());
    assert.match(talkAlias, /KellyTalk/, "/talk always serves talk.html, even in review mode");
  });
});

test("talk mode redirects a counter-role GET /voice to /counter, like conversation mode", async () => {
  await withDashboard(async (base, runtime) => {
    updateVoiceSettings(runtime.config.settingsPath, { counterMode: "talk" });
    const counterCookie = await login(base, "counter", "counter-password-1");
    const voiceResponse = await fetch(`${base}/voice`, { headers: { cookie: counterCookie }, redirect: "manual" });
    assert.equal(voiceResponse.status, 302);
    assert.equal(voiceResponse.headers.get("location"), "/counter");

    const status = await fetch(`${base}/api/voice/status`, { headers: { cookie: counterCookie } }).then((r) => r.json()) as { counterMode: string };
    assert.equal(status.counterMode, "talk");

    // The counter role can also reach /talk directly.
    const talkResponse = await fetch(`${base}/talk`, { headers: { cookie: counterCookie } });
    assert.equal(talkResponse.status, 200);
  });
});

/* ------------------------------------------------------------------ *
 * 3. GET /api/voice/greeting and /api/voice/reprompt
 * ------------------------------------------------------------------ */

test("greeting/reprompt: 404 with JSON when TTS is disabled", async () => {
  await withDashboard(async (base, runtime) => {
    const cookie = await login(base, "owner", "owner-password-1");
    const greeting = await fetch(`${base}/api/voice/greeting`, { headers: { cookie } });
    assert.equal(greeting.status, 404);
    const greetingBody = await greeting.json() as { error: string };
    assert.equal(typeof greetingBody.error, "string");
    const reprompt = await fetch(`${base}/api/voice/reprompt`, { headers: { cookie } });
    assert.equal(reprompt.status, 404);
  });
});

test("greeting: synthesises once, serves audio/wav, and is served from the disk cache on a fresh process", async () => {
  const synthDir = tempDir("kelly-talk-synth-");
  const { scriptPath, countPath } = writeCountingFakeSynth(synthDir);
  const envKeys = ["KELLY_WHISPER_CPP_PATH", "KELLY_WHISPER_MODEL_PATH", "KELLY_TTS_ENGINE", "KELLY_TTS_EXECUTABLE", "KELLY_TTS_MODEL_PATH", "KELLY_KOKORO_URL", "KELLY_KOKORO_TOKEN"];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  process.env.KELLY_TTS_ENGINE = "espeak-ng";
  process.env.KELLY_TTS_EXECUTABLE = scriptPath;
  const tempRoot = tempDir("kelly-talk-restart-");
  const previousDataDir = process.env.HENRY_DATA_DIR;
  process.env.HENRY_DATA_DIR = path.join(tempRoot, "data");

  async function boot(username: string, password: string): Promise<{ base: string; close: () => Promise<void>; cookie: () => Promise<string> }> {
    resetLoginThrottleForTests();
    const runtime = await HenryRuntime.create(tempRoot);
    runtime.config.port = 0;
    runtime.config.host = "127.0.0.1";
    createUser({ username, password, role: "admin" });
    const server = startDashboard(runtime);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    return {
      base,
      cookie: () => login(base, username, password),
      close: async () => { await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))); runtime.close(); resetLoginThrottleForTests(); },
    };
  }

  try {
    const first = await boot("owner1", "owner-password-1");
    try {
      const cookie = await first.cookie();
      const response = await fetch(`${first.base}/api/voice/greeting`, { headers: { cookie } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "audio/wav");
      assert.equal(response.headers.get("cache-control"), "private, max-age=3600");
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.subarray(0, 4).toString(), "RIFF");

      // Startup warm-up may have already synthesised the greeting once; the request above
      // must not trigger a second synthesis (in-memory cache hit).
      await new Promise((resolve) => setTimeout(resolve, 50));
      const callsAfterFirst = Number(fs.readFileSync(countPath, "utf8"));
      assert.ok(callsAfterFirst >= 1, "the fake synth ran at least once (warm-up or the request)");

      const second = await fetch(`${first.base}/api/voice/greeting`, { headers: { cookie } });
      assert.equal(second.status, 200);
      const callsAfterSecond = Number(fs.readFileSync(countPath, "utf8"));
      assert.equal(callsAfterSecond, callsAfterFirst, "a second request is served from the in-memory cache, no new synthesis");

      // Holding phrases: served like the greeting, the variant index wraps around the pack's list.
      const filler = await fetch(`${first.base}/api/voice/filler?v=0`, { headers: { cookie } });
      assert.equal(filler.status, 200);
      assert.equal(filler.headers.get("content-type"), "audio/wav");
      const fillerBytes = Buffer.from(await filler.arrayBuffer());
      const wrapped = await fetch(`${first.base}/api/voice/filler?v=${tradePack("electrical").fillers.length}`, { headers: { cookie } });
      assert.equal(wrapped.status, 200);
      assert.deepEqual(Buffer.from(await wrapped.arrayBuffer()), fillerBytes, "v wraps to the first filler");
      const junk = await fetch(`${first.base}/api/voice/filler?v=not-a-number`, { headers: { cookie } });
      assert.equal(junk.status, 200, "a malformed variant falls back to the first filler");

      const cacheDir = path.join(tempRoot, "data", "voice", "cache");
      const files = fs.readdirSync(cacheDir).filter((f) => f.endsWith(".wav"));
      assert.equal(files.length, 2 + tradePack("electrical").fillers.length, "greeting, reprompt and every filler are cached on disk");
    } finally {
      await first.close();
    }

    // A fresh process (new dashboard, same dataDir) reads the greeting straight off the disk
    // cache: the fake synth must NOT run again.
    const callsBeforeRestart = Number(fs.readFileSync(countPath, "utf8"));
    const second = await boot("owner2", "owner-password-2");
    try {
      const cookie = await second.cookie();
      const response = await fetch(`${second.base}/api/voice/greeting`, { headers: { cookie } });
      assert.equal(response.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const callsAfterRestart = Number(fs.readFileSync(countPath, "utf8"));
      assert.equal(callsAfterRestart, callsBeforeRestart, "the disk cache serves the greeting without re-synthesising in a fresh process");
    } finally {
      await second.close();
    }
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (previousDataDir === undefined) delete process.env.HENRY_DATA_DIR;
    else process.env.HENRY_DATA_DIR = previousDataDir;
  }
});

/* ------------------------------------------------------------------ *
 * 4. /vendor/vad/* static assets
 * ------------------------------------------------------------------ */

test("GET /vendor/vad/bundle.min.js serves an allowlisted asset; traversal and unknown names 404; counter role can GET but not write", async () => {
  await withDashboard(async (base, runtime) => {
    const cookie = await login(base, "owner", "owner-password-1");

    const bundle = await fetch(`${base}/vendor/vad/bundle.min.js`, { headers: { cookie } });
    if (bundle.status === 200) {
      assert.match(bundle.headers.get("content-type") || "", /javascript/);
      assert.equal(bundle.headers.get("cache-control"), "public, max-age=86400");
      const bytes = Buffer.from(await bundle.arrayBuffer());
      assert.ok(bytes.length > 0);
    } else {
      // @ricky0123/vad-web may not be installed in every environment this test runs in;
      // the route itself must still answer cleanly (404, not a crash).
      assert.equal(bundle.status, 404);
    }

    const traversal = await fetch(`${base}/vendor/vad/${encodeURIComponent("../../package.json")}`, { headers: { cookie } });
    assert.equal(traversal.status, 404);

    const unknown = await fetch(`${base}/vendor/vad/not-a-real-asset.js`, { headers: { cookie } });
    assert.equal(unknown.status, 404);

    const counterCookie = await login(base, "counter", "counter-password-1");
    const counterGet = await fetch(`${base}/vendor/vad/bundle.min.js`, { headers: { cookie: counterCookie } });
    assert.ok(counterGet.status === 200 || counterGet.status === 404, "counter role reaches the route (200 if installed, 404 if not — never 403)");

    const counterPost = await fetch(`${base}/vendor/vad/bundle.min.js`, { method: "POST", headers: { cookie: counterCookie, origin: base } });
    assert.equal(counterPost.status, 403, "the counter role cannot write to the vendor prefix");
  });
});

/* ------------------------------------------------------------------ *
 * 5. POST /api/voice/talk/session + summarizeUsage
 * ------------------------------------------------------------------ */

test("POST /api/voice/talk/session records talk.session.started/ended, and summarizeUsage counts sessions and turns", async () => {
  await withDashboard(async (base, runtime) => {
    const counterCookie = await login(base, "counter", "counter-password-1");
    const origin = base;

    const start = await fetch(`${base}/api/voice/talk/session`, {
      method: "POST", headers: { cookie: counterCookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ event: "start" }),
    });
    assert.equal(start.status, 200);

    const end = await fetch(`${base}/api/voice/talk/session`, {
      method: "POST", headers: { cookie: counterCookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ event: "end", turns: 3, reason: "press" }),
    });
    assert.equal(end.status, 200);

    const events = await runtime.activity.list(50);
    const started = events.find((e) => e.kind === "talk.session.started");
    const ended = events.find((e) => e.kind === "talk.session.ended");
    assert.ok(started, "talk.session.started was recorded");
    assert.ok(ended, "talk.session.ended was recorded");
    assert.equal(ended!.metadata?.turns, 3);
    assert.equal(ended!.metadata?.reason, "press");

    const usage = summarizeUsage(events, {});
    assert.equal(usage.talk.sessions, 1);
    assert.equal(usage.talk.turns, 3);

    const adminCookie = await login(base, "owner", "owner-password-1");
    const usageRoute = await fetch(`${base}/api/usage`, { headers: { cookie: adminCookie } }).then((r) => r.json()) as { talk: { sessions: number; turns: number } };
    assert.equal(usageRoute.talk.sessions, 1);
    assert.equal(usageRoute.talk.turns, 3);
  });
});

test("POST /api/voice/talk/session rejects an invalid event", async () => {
  await withDashboard(async (base) => {
    const cookie = await login(base, "owner", "owner-password-1");
    const response = await fetch(`${base}/api/voice/talk/session`, {
      method: "POST", headers: { cookie, origin: base, "content-type": "application/json" },
      body: JSON.stringify({ event: "pause" }),
    });
    assert.equal(response.status, 400);
  });
});
