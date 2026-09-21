import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type HenryConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { TelegramBridge, VOICE_CONFIRM_TTL_MS } from "../src/telegram/bridge.ts";
import type { PumpMetaStore, TelegramAudioMeta, TelegramUpdate } from "../src/telegram/pump.ts";
import {
  TelegramVoiceIntake, VoiceIntakeError,
  type AudioConverter, type TelegramFileFetcher, type TelegramFileInfo, type VoiceTranscriber,
} from "../src/telegram/voice.ts";

/**
 * OWNER VOICE NOTES.
 *
 * Two properties are load-bearing here and are asserted from several directions:
 *
 * 1. A voice note from anyone but the owner reaches NOTHING — no metadata call, no
 *    download, no transcription, no log line.
 * 2. A transcript is content, never consent. It only reaches the brain after a separately
 *    TYPED confirmation, so "approve it and send" spoken aloud authorizes nothing.
 *
 * Every Telegram call is faked. No test opens a socket, spawns ffmpeg, or touches a bot.
 */

const OWNER_CHAT = "12345";
const FOREIGN_CHAT = "999888";

function tempConfig(overrides: Partial<HenryConfig> = {}): HenryConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-tgvoice-"));
  const config = loadConfig(root);
  config.telegramBotToken = "test-token";
  config.telegramChatId = OWNER_CHAT;
  config.telegramStandupChatId = undefined;
  return Object.assign(config, overrides);
}

function memoryStore(): PumpMetaStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getMeta: (key) => map.get(key),
    setMeta: (key, value) => void map.set(key, value),
    deleteMeta: (key) => void map.delete(key),
  };
}

const VOICE_META: TelegramAudioMeta = { file_id: "file-abc", duration: 4, mime_type: "audio/ogg", file_size: 8_000 };

function voiceUpdate(updateId: number, chatId = OWNER_CHAT, meta: TelegramAudioMeta = VOICE_META, extra: Record<string, unknown> = {}): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId, date: Math.floor(Date.now() / 1000),
      voice: meta,
      chat: { id: Number(chatId), type: "private" },
      from: { id: 7, first_name: "Luvish" },
      ...extra,
    },
  };
}

function textUpdate(updateId: number, text: string, chatId = OWNER_CHAT): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId, date: Math.floor(Date.now() / 1000), text,
      chat: { id: Number(chatId), type: "private" },
      from: { id: 7, first_name: "Luvish" },
    },
  };
}

interface Harness {
  bridge: TelegramBridge;
  sent: string[];
  asked: string[];
  transcribed: TelegramAudioMeta[];
  store: PumpMetaStore & { map: Map<string, string> };
  activity: ActivityLog;
  config: HenryConfig;
  clock: { now: number };
  spoken: string[];
}

async function harness(options: {
  transcript?: string | (() => Promise<{ text: string; bytes: number }>);
  voiceEnabled?: boolean;
  withVoice?: boolean;
  store?: PumpMetaStore & { map: Map<string, string> };
  config?: HenryConfig;
  speak?: "ok" | "fail";
} = {}): Promise<Harness> {
  const config = options.config ?? tempConfig();
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  const sent: string[] = [];
  const asked: string[] = [];
  const transcribed: TelegramAudioMeta[] = [];
  const store = options.store ?? memoryStore();
  const clock = { now: Date.now() };
  const spoken: string[] = [];
  const voice = {
    enabled: options.voiceEnabled !== false,
    ...(options.speak
      ? { speak: async (text: string) => { spoken.push(text); return options.speak !== "fail"; } }
      : {}),
    async transcribe(meta: TelegramAudioMeta) {
      transcribed.push(meta);
      if (typeof options.transcript === "function") return { ...(await options.transcript()), language: "hi" };
      return { text: options.transcript ?? "do Havells ke pankhe ka quote banao", language: "hi", bytes: 8_000, durationSeconds: 4 };
    },
  };
  const bridge = new TelegramBridge(config, activity, store, {
    think: async (prompt) => { asked.push(prompt); return `answered: ${prompt}`; },
    send: async (_config, text) => { sent.push(text); return true; },
    now: () => clock.now,
    fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    ...(options.withVoice === false ? {} : { voice }),
  });
  return { bridge, sent, asked, transcribed, store, activity, config, clock, spoken };
}

/* ------------------------------------------------------------------ *
 * 1. The owner rail
 * ------------------------------------------------------------------ */

test("a voice note from an unknown chat reaches nothing: no metadata, no download, no transcript, no log", async () => {
  const h = await harness();
  await h.bridge.consume([voiceUpdate(1, FOREIGN_CHAT)]);
  await h.bridge.settled();

  assert.deepEqual(h.transcribed, [], "an unknown chat must never reach transcription");
  assert.deepEqual(h.sent, [], "and must never get a reply");
  assert.equal(h.bridge.stats().voiceReceived, 0);
  const logged = (await h.activity.list(50)).map((event) => `${event.kind} ${event.message}`).join("\n");
  assert.ok(!/voice/i.test(logged), "an unknown chat's media is never described in the log");
});

test("the owner's voice note is transcribed but never runs on its own", async () => {
  const h = await harness();
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();

  assert.equal(h.transcribed.length, 1);
  assert.deepEqual(h.asked, [], "a transcript alone never reaches the brain");
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /I heard/);
  assert.match(h.sent[0], /do Havells ke pankhe ka quote banao/);
  assert.match(h.sent[0], /confirm it in text/);
  assert.ok(h.store.map.get("bridge:pendingVoice"), "the transcript is armed for confirmation");
  assert.equal(h.bridge.stats().voiceTranscribed, 1);
});

/* ------------------------------------------------------------------ *
 * 2. Confirmation is typed, and only typed
 * ------------------------------------------------------------------ */

test("a typed yes runs the transcript exactly once", async () => {
  const h = await harness();
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();
  await h.bridge.consume([textUpdate(2, "yes")]);
  await h.bridge.settled();

  assert.deepEqual(h.asked, ["do Havells ke pankhe ka quote banao"], "the transcript is what runs");
  assert.equal(h.bridge.stats().voiceConfirmed, 1);
  assert.equal(h.store.map.get("bridge:pendingVoice"), undefined, "the row is cleared, so a second yes cannot replay it");

  await h.bridge.consume([textUpdate(3, "yes")]);
  await h.bridge.settled();
  assert.equal(h.asked.length, 2, "a later yes is an ordinary message, not a replay");
  assert.equal(h.asked[1], "yes");
});

test("a typed no drops the transcript and runs nothing", async () => {
  const h = await harness();
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();
  await h.bridge.consume([textUpdate(2, "no")]);
  await h.bridge.settled();

  assert.deepEqual(h.asked, []);
  assert.match(h.sent.at(-1) ?? "", /Dropped that transcript/);
  assert.equal(h.bridge.stats().voiceDiscarded, 1);
  assert.equal(h.store.map.get("bridge:pendingVoice"), undefined);
});

test("any other typed message is treated as new, and the transcript is dropped", async () => {
  const h = await harness();
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();
  await h.bridge.consume([textUpdate(2, "actually quote Philips instead")]);
  await h.bridge.settled();

  assert.deepEqual(h.asked, ["actually quote Philips instead"], "the typed message runs, not the transcript");
  assert.ok(h.sent.some((text) => /taking this as a new message/.test(text)));
  assert.equal(h.bridge.stats().voiceDiscarded, 1);
});

test("spoken approval authorizes nothing: the words are content, the gate is typed", async () => {
  const h = await harness({ transcript: "yes approve it and send the quotation to the customer now" });
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();

  assert.deepEqual(h.asked, [], "a transcript that says yes still confirms nothing");
  assert.match(h.sent[0], /confirm it in text/);

  await h.bridge.consume([textUpdate(2, "yes")]);
  await h.bridge.settled();
  assert.equal(h.asked.length, 1, "only the typed yes releases it");
  assert.equal(h.asked[0], "yes approve it and send the quotation to the customer now");
});

test("an expired transcript is never run by a much later yes", async () => {
  const h = await harness();
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();
  h.clock.now += VOICE_CONFIRM_TTL_MS + 1;
  await h.bridge.consume([textUpdate(2, "yes")]);
  await h.bridge.settled();

  assert.deepEqual(h.asked, ["yes"], "the stale transcript is gone; only the typed word remains");
});

test("a restart still requires confirmation and runs the transcript once", async () => {
  const store = memoryStore();
  const config = tempConfig();
  const first = await harness({ store, config });
  await first.bridge.consume([voiceUpdate(1)]);
  await first.bridge.settled();
  assert.deepEqual(first.asked, []);

  // A brand-new bridge over the same store is the restart.
  const second = await harness({ store, config });
  await second.bridge.consume([textUpdate(2, "haan")]);
  await second.bridge.settled();
  assert.deepEqual(second.asked, ["do Havells ke pankhe ka quote banao"]);
  assert.deepEqual(first.asked, [], "the pre-restart instance never ran it");
});

/* ------------------------------------------------------------------ *
 * 3. Duplicates, staleness, failures
 * ------------------------------------------------------------------ */

test("a replayed batch transcribes once", async () => {
  const h = await harness();
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();
  assert.equal(h.transcribed.length, 1);
});

test("a stale voice note is counted and dropped without transcription", async () => {
  const h = await harness();
  const stale = voiceUpdate(1);
  stale.message!.date = Math.floor(Date.now() / 1000) - 48 * 60 * 60;
  await h.bridge.consume([stale]);
  await h.bridge.settled();
  assert.deepEqual(h.transcribed, []);
  assert.equal(h.bridge.stats().stale, 1);
});

test("a failed transcription replies once and never reaches the brain", async () => {
  const h = await harness({
    transcript: async () => { throw new VoiceIntakeError("I could not convert that audio (ffmpeg missing).", "conversion_failed"); },
  });
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();

  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /could not convert that audio/);
  assert.deepEqual(h.asked, []);
  assert.equal(h.bridge.stats().voiceRejected, 1);
  const failure = (await h.activity.list(50)).find((event) => event.kind === "run.failed");
  assert.ok(failure, "the failure is recorded");
  assert.equal(failure?.metadata?.code, "conversion_failed");
});

test("without local transcription the note is declined in one sentence", async () => {
  const h = await harness({ withVoice: false });
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /cannot transcribe voice notes/);
  assert.deepEqual(h.asked, []);
});

test("ordinary text chat is unchanged while voice is wired", async () => {
  const h = await harness();
  await h.bridge.consume([textUpdate(1, "what is the price of a 20W batten?")]);
  await h.bridge.settled();
  assert.deepEqual(h.asked, ["what is the price of a 20W batten?"]);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /^answered:/);
  assert.equal(h.bridge.stats().voiceReceived, 0);
});

test("neither the bot token nor a file id is ever written to the activity log", async () => {
  const h = await harness();
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();
  const serialized = JSON.stringify(await h.activity.list(50));
  assert.ok(!serialized.includes("test-token"), "the bot token never reaches the log");
  assert.ok(!serialized.includes("file-abc"), "the Telegram file id never reaches the log");
  assert.ok(!serialized.includes("Havells"), "the transcript itself stays out of the log");
});

test("an edited voice message is not transcribed again", async () => {
  const h = await harness();
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();
  assert.equal(h.transcribed.length, 1);

  // Telegram sends an edit (a caption change, typically) as a NEW update id carrying the
  // same audio. Re-reading it would re-download the file and arm a second transcript.
  const edit: TelegramUpdate = { update_id: 2, edited_message: voiceUpdate(1).message };
  await h.bridge.consume([edit]);
  await h.bridge.settled();

  assert.equal(h.transcribed.length, 1, "the same audio is never transcribed twice");
  assert.equal(h.sent.length, 1, "and the owner is not told twice");
});

test("an error message carrying a URL is redacted before it reaches the chat", async () => {
  const h = await harness({
    transcript: async () => { throw new Error("download failed from https://api.telegram.org/file/bot123:SECRET/voice/a.oga"); },
  });
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();

  assert.equal(h.sent.length, 1);
  assert.ok(!h.sent[0].includes("SECRET"), "a token never reaches the chat");
  assert.ok(!h.sent[0].includes("https://"), "and neither does the URL");
});

/* ------------------------------------------------------------------ *
 * 3b. Spoken replies (opt-in, and never load-bearing)
 * ------------------------------------------------------------------ */

test("a confirmed voice turn is answered in text and then spoken", async () => {
  const h = await harness({ speak: "ok" });
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();
  await h.bridge.consume([textUpdate(2, "yes")]);
  await h.bridge.settled();

  const answer = "answered: do Havells ke pankhe ka quote banao";
  assert.ok(h.sent.includes(answer), "the text answer is always sent");
  assert.deepEqual(h.spoken, [answer], "and the same answer is offered as speech");
  assert.equal(h.bridge.stats().voiceSpoken, 1);
});

test("a typed turn is never spoken back", async () => {
  const h = await harness({ speak: "ok" });
  await h.bridge.consume([textUpdate(1, "what is the rate of a 9W bulb?")]);
  await h.bridge.settled();
  assert.equal(h.asked.length, 1);
  assert.deepEqual(h.spoken, [], "speech is offered only for a turn the owner spoke");
});

test("a failed spoken reply is silent: the text answer still stands", async () => {
  const h = await harness({ speak: "fail" });
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();
  await h.bridge.consume([textUpdate(2, "yes")]);
  await h.bridge.settled();

  assert.ok(h.sent.some((text) => text.startsWith("answered:")), "the owner still has the answer");
  assert.equal(h.bridge.stats().voiceSpoken, 0, "a failed voice reply is not counted");
  assert.equal(h.bridge.stats().failed, 0, "and is never reported as a turn failure");
});

test("without the opt-in speaker nothing is spoken", async () => {
  const h = await harness();
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();
  await h.bridge.consume([textUpdate(2, "yes")]);
  await h.bridge.settled();
  assert.deepEqual(h.spoken, []);
  assert.equal(h.bridge.stats().voiceSpoken, 0);
});

/* ------------------------------------------------------------------ *
 * 4. The intake: bounded before, during and after the download
 * ------------------------------------------------------------------ */

function fakeIntake(options: {
  file?: TelegramFileInfo;
  bytes?: Buffer;
  download?: (file: TelegramFileInfo, maxBytes: number) => Promise<Buffer>;
  convert?: (input: Buffer) => Promise<Buffer>;
  transcribe?: (wav: Uint8Array) => Promise<{ text: string }>;
  sttEnabled?: boolean;
  limits?: { maxBytes?: number; maxSeconds?: number };
} = {}): { intake: TelegramVoiceIntake; calls: { getFile: number; download: number; convert: number; transcribe: number } } {
  const calls = { getFile: 0, download: 0, convert: 0, transcribe: 0 };
  const fetcher: TelegramFileFetcher = {
    async getFile() { calls.getFile += 1; return options.file ?? { filePath: "voice/file_1.oga", fileSize: 8_000 }; },
    async download(file, maxBytes) {
      calls.download += 1;
      if (options.download) return await options.download(file, maxBytes);
      return options.bytes ?? Buffer.from("opus-bytes");
    },
  };
  const converter: AudioConverter = {
    async toWav16kMono(input) {
      calls.convert += 1;
      if (options.convert) return await options.convert(input);
      return Buffer.from("RIFFfake");
    },
  };
  const transcriber: VoiceTranscriber = {
    sttEnabled: () => options.sttEnabled !== false,
    async transcribe(wav) {
      calls.transcribe += 1;
      if (options.transcribe) return await options.transcribe(wav);
      return { text: "  ek 20W batten ka rate  ", language: "hi" };
    },
  };
  return { intake: new TelegramVoiceIntake({ fetcher, converter, transcriber, limits: options.limits }), calls };
}

test("intake screens size, duration and format BEFORE any Telegram call", async () => {
  const cases: Array<[TelegramAudioMeta, string]> = [
    [{ file_id: "a", file_size: 50 * 1024 * 1024 }, "too_large"],
    [{ file_id: "a", duration: 9_000 }, "too_long"],
    [{ file_id: "a", mime_type: "video/mp4" }, "unsupported_media"],
    [{ file_id: "" }, "unsupported_media"],
  ];
  for (const [meta, code] of cases) {
    const { intake, calls } = fakeIntake();
    await assert.rejects(() => intake.transcribe(meta), (error: VoiceIntakeError) => {
      assert.equal(error.code, code);
      return true;
    });
    assert.equal(calls.getFile, 0, `${code}: nothing is fetched`);
    assert.equal(calls.download, 0, `${code}: nothing is downloaded`);
  }
});

test("intake enforces the byte cap again during and after the download", async () => {
  const oversizedStream = fakeIntake({
    download: async (_file, maxBytes) => { throw new VoiceIntakeError(`over ${maxBytes}`, "too_large"); },
  });
  await assert.rejects(() => oversizedStream.intake.transcribe({ file_id: "a" }), (error: VoiceIntakeError) => error.code === "too_large");

  // A fetcher that ignores its own cap must still not reach conversion.
  const liar = fakeIntake({ bytes: Buffer.alloc(2_048), limits: { maxBytes: 1_024 } });
  await assert.rejects(() => liar.intake.transcribe({ file_id: "a" }), (error: VoiceIntakeError) => error.code === "too_large");
  assert.equal(liar.calls.convert, 0, "oversized audio never reaches the converter");

  // Telegram's own metadata is re-checked too.
  const bigFile = fakeIntake({ file: { filePath: "voice/x.oga", fileSize: 9_999 }, limits: { maxBytes: 1_000 } });
  await assert.rejects(() => bigFile.intake.transcribe({ file_id: "a" }), (error: VoiceIntakeError) => error.code === "too_large");
  assert.equal(bigFile.calls.download, 0);
});

test("intake maps conversion, transcription and empty-transcript failures to codes", async () => {
  const conversion = fakeIntake({ convert: async () => { throw new Error("ffmpeg exited 1"); } });
  await assert.rejects(() => conversion.intake.transcribe({ file_id: "a" }), (error: VoiceIntakeError) => error.code === "conversion_failed");

  const stt = fakeIntake({ transcribe: async () => { throw new Error("whisper exploded"); } });
  await assert.rejects(() => stt.intake.transcribe({ file_id: "a" }), (error: VoiceIntakeError) => error.code === "transcription_failed");

  const silent = fakeIntake({ transcribe: async () => ({ text: "   " }) });
  await assert.rejects(() => silent.intake.transcribe({ file_id: "a" }), (error: VoiceIntakeError) => error.code === "transcription_failed");

  const disabled = fakeIntake({ sttEnabled: false });
  await assert.rejects(() => disabled.intake.transcribe({ file_id: "a" }), (error: VoiceIntakeError) => error.code === "disabled");
  assert.equal(disabled.calls.getFile, 0, "a disabled adapter never calls Telegram");
});

test("intake never leaks a token or URL into an error message", async () => {
  const leaky = fakeIntake({
    convert: async () => { throw new Error("failed at https://api.telegram.org/file/bot123:SECRET/voice/file_1.oga"); },
  });
  await assert.rejects(() => leaky.intake.transcribe({ file_id: "a" }), (error: VoiceIntakeError) => {
    assert.ok(!error.message.includes("SECRET"), "the token never rides out inside an error");
    assert.ok(!error.message.includes("https://"), "and neither does the URL");
    assert.match(error.message, /\[url\]/);
    return true;
  });
});

test("intake returns the trimmed transcript with the bytes it actually read", async () => {
  const { intake, calls } = fakeIntake({ bytes: Buffer.alloc(1_234) });
  const result = await intake.transcribe({ file_id: "a", duration: 6 });
  assert.equal(result.text, "ek 20W batten ka rate");
  assert.equal(result.bytes, 1_234);
  assert.equal(result.durationSeconds, 6);
  assert.deepEqual(calls, { getFile: 1, download: 1, convert: 1, transcribe: 1 });
});
