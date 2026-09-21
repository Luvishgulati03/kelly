import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type HenryConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { StandupStore, istDateKey } from "../src/standup/store.ts";
import { StandupPoller } from "../src/standup/poller.ts";
import { updateSettings } from "../src/util/settings.ts";
import { TelegramPump, type PumpMetaStore, type TelegramUpdate } from "../src/telegram/pump.ts";
import {
  TelegramBridge, bridgeEnabled, chunkTelegramText, terminalOnlyReason,
  BRIDGE_MAX_PENDING, TELEGRAM_MAX_CHARS,
} from "../src/telegram/bridge.ts";
import { LunaOrchestrator } from "../src/orchestration/luna.ts";
import type { HenryMemory } from "../src/memory/engram.ts";
import type { RunResult } from "../src/types.ts";
import { HenryRuntime } from "../src/runtime.ts";
import { setActiveProfile, getActiveProfile } from "../src/profile.ts";

const LUVISH_CHAT = "12345";
const STANDUP_CHAT = "-100777";
const FOREIGN_CHAT = "999888";
const FOREIGN_TEXT = "hello henry, i am a stranger with a secret";

function tempConfig(overrides: Partial<HenryConfig> = {}): HenryConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "henry-tgbridge-"));
  const config = loadConfig(root);
  // Test doubles ONLY — never the real .env values, so no test can touch the live bot.
  config.telegramBotToken = "test-token";
  config.telegramChatId = LUVISH_CHAT;
  config.telegramStandupChatId = undefined;
  return Object.assign(config, overrides);
}

async function activityFor(config: HenryConfig): Promise<ActivityLog> {
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  return activity;
}

/** In-memory PumpMetaStore — no DB needed for the bridge-only tests. */
function memoryStore(): PumpMetaStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getMeta: (key) => map.get(key),
    setMeta: (key, value) => void map.set(key, value),
    deleteMeta: (key) => void map.delete(key),
  };
}

function dm(updateId: number, text: string, chatId = LUVISH_CHAT, extra: Record<string, unknown> = {}): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId, date: Math.floor(Date.now() / 1000), text,
      chat: { id: Number(chatId), type: "private" },
      from: { id: 7, first_name: "Luvish" },
      ...extra,
    },
  };
}

function voiceDm(updateId: number, chatId = LUVISH_CHAT): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId, date: Math.floor(Date.now() / 1000),
      voice: { file_id: "voice-file", duration: 3 },
      chat: { id: Number(chatId), type: "private" },
      from: { id: 7, first_name: "Luvish" },
    },
  };
}

interface Harness {
  config: HenryConfig;
  bridge: TelegramBridge;
  sent: string[];
  asked: string[];
  chatActions: number;
}

async function bridgeHarness(options: {
  answer?: (prompt: string, report: (text: string) => Promise<boolean>) => Promise<string> | string;
  sendOk?: boolean;
  config?: HenryConfig;
  snapshot?: () => Promise<import("../src/telegram/bridge.ts").ReflexSnapshot>;
} = {}): Promise<Harness> {
  const config = options.config ?? tempConfig();
  const activity = await activityFor(config);
  const sent: string[] = [];
  const asked: string[] = [];
  let chatActions = 0;
  const harness = {
    config, sent, asked,
    get chatActions() { return chatActions; },
  } as Harness;
  harness.bridge = new TelegramBridge(config, activity, memoryStore(), {
    think: async (prompt, report) => { asked.push(prompt); return options.answer ? await options.answer(prompt, report) : "pong"; },
    send: async (_config, text) => { sent.push(text); return options.sendOk !== false; },
    fetchImpl: (async () => { chatActions += 1; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch,
    ...(options.snapshot ? { snapshot: options.snapshot } : {}),
  });
  return harness;
}

test("bridge: Luvish's DM runs the brain and the answer comes back in his chat", async () => {
  const h = await bridgeHarness({ answer: (prompt) => `heard: ${prompt}` });
  await h.bridge.consume([dm(1, "how's the memory module doing?")]);
  await h.bridge.settled();

  assert.deepEqual(h.asked, ["how's the memory module doing?"]);
  assert.deepEqual(h.sent, ["heard: how's the memory module doing?"]);
  assert.equal(h.bridge.stats().replies, 1);
  assert.ok(h.chatActions >= 1, "a typing indicator must fire while Henry thinks");
});

test("bridge: delegated work acknowledges first and can report later without blocking intake", async () => {
  const longReport = "r".repeat(TELEGRAM_MAX_CHARS + 200);
  let reportDelivered!: () => void;
  const delivered = new Promise<void>((resolve) => { reportDelivered = resolve; });
  const h = await bridgeHarness({
    answer: (_prompt, report) => {
      setImmediate(() => { void report(longReport).then(() => reportDelivered()); });
      return "Started — I'll report back.";
    },
  });

  await h.bridge.consume([dm(1, "Do deep research on agent queues.")]);
  await h.bridge.settled();
  assert.equal(h.sent[0], "Started — I'll report back.");
  assert.equal(h.bridge.stats().thinking, false, "the foreground queue is released after acknowledgement");
  await delivered;
  assert.equal(h.sent.length, 3, "the later report is safely split across Telegram's limit");
  assert.equal(h.sent.slice(1).join(""), longReport);
});

test("bridge: any chat that is not Luvish's gets no reply, no brain call, and is never stored", async () => {
  const h = await bridgeHarness();
  await h.bridge.consume([dm(1, FOREIGN_TEXT, FOREIGN_CHAT), dm(2, "group thing", STANDUP_CHAT)]);
  await h.bridge.settled();

  assert.deepEqual(h.sent, [], "silence is the only correct response to a stranger");
  assert.deepEqual(h.asked, []);
  const activityText = fs.readFileSync(h.config.activityPath, "utf8");
  assert.ok(!activityText.includes(FOREIGN_TEXT), "a stranger's message text must never be persisted anywhere");
});

test("bridge: bot echoes and blank messages in Luvish's own chat are skipped", async () => {
  const h = await bridgeHarness();
  await h.bridge.consume([
    dm(1, "the summary I just sent", LUVISH_CHAT, { from: { id: 99, is_bot: true, first_name: "Henry" } }),
    dm(2, "   "),
    { update_id: 3, message: { message_id: 3, date: Math.floor(Date.now() / 1000), chat: { id: Number(LUVISH_CHAT), type: "private" }, from: { id: 7 } } },
  ]);
  await h.bridge.settled();
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.asked, []);
});

test("bridge: replies longer than the Telegram cap are chunked, never truncated", async () => {
  const long = "x".repeat(9000);
  const h = await bridgeHarness({ answer: () => long });
  await h.bridge.consume([dm(1, "give me everything")]);
  await h.bridge.settled();

  assert.equal(h.sent.length, 3);
  for (const chunk of h.sent) assert.ok(chunk.length <= TELEGRAM_MAX_CHARS, `chunk of ${chunk.length} exceeds the cap`);
  assert.equal(h.sent.join(""), long, "chunking must lose nothing");
});

test("chunkTelegramText prefers newline/word boundaries and never splits a surrogate pair", () => {
  const paragraphs = `${"a".repeat(4000)}\n${"b".repeat(4000)}`;
  const chunks = chunkTelegramText(paragraphs);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], "a".repeat(4000));
  assert.equal(chunks[1], "b".repeat(4000));

  // Sized so the naive cut lands exactly between 💚's two UTF-16 code units.
  const emoji = `${"x".repeat(TELEGRAM_MAX_CHARS - 1)}💚tail`;
  for (const chunk of chunkTelegramText(emoji)) {
    const last = chunk.charCodeAt(chunk.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), "a lone high surrogate makes Telegram 400 the whole message");
  }
  assert.deepEqual(chunkTelegramText(""), []);
});

test("bridge: destructive / long-running asks are deferred to the terminal without touching the brain", async () => {
  const h = await bridgeHarness();
  await h.bridge.consume([dm(1, "push the branch and deploy it")]);
  await h.bridge.settled();

  assert.deepEqual(h.asked, [], "a repo mutation must never reach the provider from a phone");
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /terminal session/i);
  assert.equal(h.bridge.stats().deferred, 1);

  // ...while questions ABOUT the repo stay ordinary conversation.
  assert.equal(terminalOnlyReason("what did you change in the repo yesterday?"), undefined);
  assert.equal(terminalOnlyReason("how are you?"), undefined);
  assert.equal(terminalOnlyReason("remind me to call mom at 6"), undefined);
  assert.ok(terminalOnlyReason("git commit everything"));
  assert.ok(terminalOnlyReason("run the full test suite"));
  assert.ok(terminalOnlyReason("refactor the memory module for me"));
});

test("bridge: one brain call in flight, at most 5 queued, older ones dropped with a note", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let inFlight = 0;
  let maxInFlight = 0;
  let first = true;
  const h = await bridgeHarness({
    answer: async (prompt) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (first) { first = false; await gate; }
      inFlight -= 1;
      return `ack:${prompt}`;
    },
  });

  // 8 arrive at once: the queue caps at 5 (m4..m8), so the 3 oldest are dropped unread.
  await h.bridge.consume(Array.from({ length: 8 }, (_, index) => dm(index + 1, `m${index + 1}`)));
  await new Promise((resolve) => setImmediate(resolve)); // m4 is now the one in flight
  // 3 more land mid-think: 4 waiting + 3 new = 7, capped back to 5, dropping m5 and m6.
  await h.bridge.consume([dm(9, "m9"), dm(10, "m10"), dm(11, "m11")]);
  release();
  await h.bridge.settled();

  assert.equal(maxInFlight, 1, "exactly one brain call may ever be in flight");
  assert.equal(h.bridge.stats().dropped, 5);
  assert.equal(h.asked.length, 1 + BRIDGE_MAX_PENDING, "the in-flight one plus the five that survived the queue");
  assert.deepEqual(h.asked, ["m4", "m7", "m8", "m9", "m10", "m11"]);
  assert.ok(h.sent.some((text) => /dropped 3 earlier messages/.test(text)), "drops must be admitted, not hidden");
  assert.equal(h.asked.at(-1), "m11", "the newest message always survives");
});

test("bridge: a brain failure still gets an honest reply, never silence", async () => {
  const h = await bridgeHarness({ answer: () => { throw new Error("provider exploded"); } });
  await h.bridge.consume([dm(1, "hey")]);
  await h.bridge.settled();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /error/i);
  assert.equal(h.bridge.stats().failed, 1);
});

test("bridge: the kill switch takes it off the pump entirely", async () => {
  const config = tempConfig();
  assert.equal(bridgeEnabled(config.settingsPath), true, "default ON once the env vars exist");
  updateSettings(config.settingsPath, { telegram: { bridge: { enabled: false } } });
  assert.equal(bridgeEnabled(config.settingsPath), false);

  const h = await bridgeHarness({ config });
  assert.equal(h.bridge.enabled, false);
  assert.equal(h.bridge.chatId, undefined, "no chat id = the pump never routes to it");
  await h.bridge.consume([dm(1, "you there?")]);
  await h.bridge.settled();
  assert.deepEqual(h.sent, []);

  updateSettings(config.settingsPath, { telegram: { bridge: { enabled: true } } });
  assert.equal(h.bridge.enabled, true, "the switch is read fresh, never cached");
});

test("bridge: an unconfigured DM chat id makes the whole bridge inert", async () => {
  const config = tempConfig();
  config.telegramChatId = undefined;
  const h = await bridgeHarness({ config });
  assert.equal(h.bridge.configured, false);
  assert.equal(h.bridge.chatId, undefined);
  await h.bridge.consume([dm(1, "hi")]);
  await h.bridge.settled();
  assert.deepEqual(h.sent, []);
});

test("bridge: messages older than the staleness window are counted, not answered", async () => {
  const h = await bridgeHarness();
  const ancient = dm(1, "sent three days ago");
  ancient.message!.date = Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60;
  await h.bridge.consume([ancient]);
  await h.bridge.settled();
  assert.deepEqual(h.sent, []);
  assert.equal(h.bridge.stats().stale, 1);
});

// ---------------------------------------------------------------------------
// The shared pump: one getUpdates consumer, two modules behind it.
// ---------------------------------------------------------------------------

interface PumpHarness {
  config: HenryConfig;
  store: StandupStore;
  pump: TelegramPump;
  bridge: TelegramBridge;
  poller: StandupPoller;
  sent: string[];
  urls: string[];
  batches: TelegramUpdate[][];
}

async function pumpHarness(batches: TelegramUpdate[][]): Promise<PumpHarness> {
  const config = tempConfig();
  config.telegramStandupChatId = STANDUP_CHAT;
  const activity = await activityFor(config);
  const store = new StandupStore(config);
  const sent: string[] = [];
  const urls: string[] = [];

  // The standup poller's ONLY remaining fetch is getMe (the addressed-only rail's identity).
  const identityFetch = (async () => ({
    ok: true, status: 200, json: async () => ({ ok: true, result: { id: 99, username: "henry_test_bot" } }),
  })) as unknown as typeof fetch;

  let call = 0;
  const pumpFetch = (async (url: string | URL) => {
    urls.push(String(url));
    const batch = batches[Math.min(call, batches.length - 1)] ?? [];
    call += 1;
    return { ok: true, status: 200, json: async () => ({ ok: true, result: batch }) };
  }) as unknown as typeof fetch;

  const bridge = new TelegramBridge(config, activity, store, {
    think: async (prompt) => `re: ${prompt}`,
    send: async (_config, text) => { sent.push(text); return true; },
    fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
  });
  const poller = new StandupPoller(config, activity, store, identityFetch);
  const pump = new TelegramPump(config, activity, store, [bridge, poller], pumpFetch);
  return { config, store, pump, bridge, poller, sent, urls, batches };
}

test("pump: routes Luvish's DM to the bridge, the group to standup's unchanged intake, ignores the rest", async () => {
  const groupDate = 1754640000;
  const h = await pumpHarness([[
    dm(10, "what's on my plate today?"),
    { update_id: 11, message: { message_id: 2, date: groupDate, text: "@henry_test_bot standup yaha", chat: { id: Number(STANDUP_CHAT), type: "supergroup" }, from: { id: 8, first_name: "Rohan" } } },
    { update_id: 12, message: { message_id: 3, date: groupDate, text: "untagged banter", chat: { id: Number(STANDUP_CHAT), type: "supergroup" }, from: { id: 8, first_name: "Priya" } } },
    dm(13, FOREIGN_TEXT, FOREIGN_CHAT),
  ]]);

  const result = await h.pump.pollOnce();
  await h.bridge.settled();

  assert.equal(result.polled, true);
  assert.equal(result.seenUpdates, 4);
  assert.deepEqual(result.routed, { bridge: 1, standup: 2 });
  assert.equal(result.ignored, 1, "the stranger's DM is counted and dropped");

  assert.deepEqual(h.sent, ["re: what's on my plate today?"], "only Luvish gets an answer");

  const rows = h.store.unscanned(istDateKey(groupDate));
  assert.equal(rows.length, 1, "the addressed group message still reaches standup intake");
  assert.equal(rows[0].text, "standup yaha", "standup's addressed-only rail is untouched by the new transport");

  const activityText = fs.readFileSync(h.config.activityPath, "utf8");
  assert.ok(!activityText.includes(FOREIGN_TEXT));
  h.pump.stop();
  h.store.close();
});

test("pump: the offset persists and confirms past the batch — nothing is processed twice", async () => {
  const h = await pumpHarness([
    [dm(20, "first")],
    [],
  ]);

  await h.pump.pollOnce();
  await h.bridge.settled();
  assert.equal(h.store.getMeta("poller:lastUpdateId"), "20");
  // LONG POLL, not a busy tick: Telegram holds the request open until a message arrives,
  // which is what removed the ~30s of average dead air before Henry even read a DM.
  assert.match(h.urls[0], /timeout=(?!0\b)\d+/, "getUpdates must long-poll");
  assert.ok(!h.urls[0].includes("offset="), "the first ever poll has no offset to confirm");

  await h.pump.pollOnce();
  assert.match(h.urls[1], /offset=21/, "the next poll must confirm past the last update id");
  assert.deepEqual(h.sent, ["re: first"]);
  h.pump.stop();
  h.store.close();
});

test("pump: a re-delivered batch (crash before confirm) never produces a duplicate reply", async () => {
  const h = await pumpHarness([[dm(30, "did you get this?")], [dm(30, "did you get this?")]]);

  await h.pump.pollOnce();
  await h.bridge.settled();
  assert.deepEqual(h.sent, ["re: did you get this?"]);

  // Telegram re-serves the same update (the offset write lost to a crash).
  h.store.deleteMeta("poller:lastUpdateId");
  await h.pump.pollOnce();
  await h.bridge.settled();
  assert.deepEqual(h.sent, ["re: did you get this?"], "the bridge's own watermark stops the double reply");
  h.pump.stop();
  h.store.close();
});

test("pump: standup holding an unconfirmed batch keeps the offset put", async () => {
  const h = await pumpHarness([[
    { update_id: 40, message: { message_id: 1, date: 1754640000, text: "@henry_test_bot standup", chat: { id: Number(STANDUP_CHAT), type: "supergroup" }, from: { id: 8, first_name: "Rohan" } } },
  ]]);
  // getMe failing = the addressed-only rail cannot run, so the batch must NOT be confirmed.
  const broken = new StandupPoller(h.config, await activityFor(h.config), h.store, (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
  const pump = new TelegramPump(h.config, await activityFor(h.config), h.store, [broken], (async () => ({
    ok: true, status: 200, json: async () => ({ ok: true, result: [{ update_id: 40, message: { message_id: 1, date: 1754640000, text: "@x standup", chat: { id: Number(STANDUP_CHAT), type: "supergroup" }, from: { id: 8, first_name: "Rohan" } } }] }),
  })) as unknown as typeof fetch);

  const result = await pump.pollOnce();
  assert.equal(result.polled, false);
  assert.equal(result.held, true);
  assert.equal(h.store.getMeta("poller:lastUpdateId"), undefined, "an unconfirmed batch must re-deliver, never vanish");
  pump.stop();
  h.pump.stop();
  h.store.close();
});

test("pump: refuses to poll behind a live lock holder, and no-ops with no configured consumers", async () => {
  const h = await pumpHarness([[]]);
  // pid 1 (launchd) is always alive on macOS — a fresh lock held by it must block us.
  h.store.setMeta("poller:lock", `1:${Date.now()}`);
  const blocked = await h.pump.pollOnce();
  assert.equal(blocked.polled, false);
  assert.match(blocked.reason!, /another process/);

  const bare = tempConfig();
  bare.telegramChatId = undefined;
  bare.telegramStandupChatId = undefined;
  const idle = new TelegramPump(bare, await activityFor(bare), memoryStore(), [
    new TelegramBridge(bare, await activityFor(bare), memoryStore(), { think: async () => "x", send: async () => true }),
  ], (async () => { throw new Error("must never fetch"); }) as unknown as typeof fetch);
  const result = await idle.pollOnce();
  assert.equal(result.polled, false);
  assert.match(result.reason!, /no telegram consumers/);
  h.pump.stop();
  h.store.close();
});

/**
 * THE REFLEX LANE. "What are you working on?" is answered from the dispatch registry and
 * the approval queue — no provider, and crucially NOT through the sequential queue, so it
 * lands while a long turn is still thinking. That is what keeps Henry usable as an
 * orchestrator instead of going mute for the length of whatever he is doing.
 */
test("bridge: a status question is answered from local state without waking the brain", async () => {
  const h = await bridgeHarness({
    snapshot: async () => ({
      running: [{ role: "researcher", task: "read the pricing page", startedAt: new Date(Date.now() - 90_000).toISOString() }],
      recentDone: 2,
      pendingApprovals: 3,
      provider: "claude",
    }),
  });

  await h.bridge.consume([dm(1, "what are you working on?")]);
  await h.bridge.settled();

  assert.deepEqual(h.asked, [], "a local-state question must never reach the provider");
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /researcher/, "it should name what is actually running");
  assert.match(h.sent[0], /read the pricing page/);
  assert.equal(h.bridge.stats().reflex, 1);
});

test("bridge: reflex answers arrive WHILE a long turn is still thinking", async () => {
  let releaseLongTurn = (): void => {};
  const blocked = new Promise<void>((resolve) => { releaseLongTurn = resolve; });
  const h = await bridgeHarness({
    answer: async () => { await blocked; return "the long answer"; },
    snapshot: async () => ({ running: [], recentDone: 0, pendingApprovals: 4, provider: "codex" }),
  });

  // A heavy turn starts and stays in flight...
  await h.bridge.consume([dm(1, "write me a full plan for the quarter")]);
  // ...and a status question arrives behind it.
  await h.bridge.consume([dm(2, "anything pending?")]);

  // It is answered NOW, without waiting for the brain to finish.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(h.sent, ["4 waiting on your approval."], "the reflex reply must not queue behind the brain");
  assert.equal(h.bridge.stats().thinking, true, "and the long turn is genuinely still running");

  releaseLongTurn();
  await h.bridge.settled();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1], "the long answer");
});

test("bridge: anything needing judgement still goes to the brain", async () => {
  const h = await bridgeHarness({
    answer: () => "thought about it",
    snapshot: async () => ({ running: [], recentDone: 0, pendingApprovals: 0, provider: "claude" }),
  });
  await h.bridge.consume([dm(1, "what do you think we should do about the pricing page?")]);
  await h.bridge.settled();
  assert.equal(h.asked.length, 1, "the reflex patterns must stay narrow — this one needs a brain");
  assert.equal(h.bridge.stats().reflex, 0);
});

/**
 * THE QUOTA WALL (Luvish, live 2026-09-09: Codex ran out mid-conversation).
 *
 * Running out of quota is not a failed answer, it is an UNANSWERED QUESTION. It used to
 * surface as an ordinary empty response, so the bridge replied "say it again" and dropped
 * the turn — the one thing Luvish had actually asked for was the thing that got lost.
 */
test("bridge: a turn killed by a quota wall is kept, and resumes BEFORE the next message", async () => {
  const store = memoryStore();
  const config = tempConfig();
  const activity = await activityFor(config);
  const sent: string[] = [];
  const asked: string[] = [];
  let outOfQuota = true;

  const bridge = new TelegramBridge(config, activity, store, {
    think: async (prompt) => {
      asked.push(prompt);
      if (outOfQuota) throw Object.assign(new Error("every provider is out of quota"), { deferrable: true });
      return `answered: ${prompt}`;
    },
    send: async (_config, text) => { sent.push(text); return true; },
    fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
  });

  await bridge.consume([dm(1, "summarise the pricing research")]);
  await bridge.settled();
  assert.equal(bridge.stats().deferredByLimit, 1);
  assert.match(sent[0], /out of provider quota/i, "he should be told plainly, not fobbed off");
  assert.ok(!/say it again/i.test(sent[0]), "the turn was kept, so do not ask him to retype it");
  assert.ok(store.map.get("bridge:deferredTurn"), "the parked turn must survive a restart");

  // Quota returns, and the next message arrives.
  outOfQuota = false;
  await bridge.consume([dm(2, "also what's the weather")]);
  await bridge.settled();

  assert.deepEqual(
    asked,
    ["summarise the pricing research", "summarise the pricing research", "also what's the weather"],
    "the parked turn is retried FIRST, then the new message — the order he asked them in",
  );
  assert.equal(bridge.stats().resumed, 1);
  assert.ok(!store.map.get("bridge:deferredTurn"), "and it is cleared once taken, never replayed twice");
});

test("bridge: an ordinary brain failure is NOT parked — only a quota wall is", async () => {
  const store = memoryStore();
  const config = tempConfig();
  const activity = await activityFor(config);
  const sent: string[] = [];
  const bridge = new TelegramBridge(config, activity, store, {
    think: async () => { throw new Error("the model broke"); },
    send: async (_config, text) => { sent.push(text); return true; },
    fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
  });

  await bridge.consume([dm(1, "do a thing")]);
  await bridge.settled();
  assert.equal(bridge.stats().deferredByLimit, 0, "a genuine error must not be queued up for replay");
  assert.equal(bridge.stats().failed, 1);
  assert.ok(!store.map.get("bridge:deferredTurn"));
  assert.match(sent[0], /say it again/i);
});

/* ------------------------------------------------------------------ *
 * 5. An undelivered answer never settles a confirmed voice transcript
 * ------------------------------------------------------------------ */

test("bridge: an undelivered answer never settles a confirmed voice transcript as answered", async () => {
  const store = memoryStore();
  const config = tempConfig();
  const activity = await activityFor(config);
  const settles: Array<{ id: string; state: string; reply?: string }> = [];
  const bridge = new TelegramBridge(config, activity, store, {
    think: async () => "here is the quote",
    // Every send fails — the preview reply, the confirmation notice, and the final answer.
    send: async () => false,
    fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    voice: {
      enabled: true,
      transcribe: async () => ({ text: "quote a fan", id: "voice-1", bytes: 10 }),
      settle: (id, state, reply) => { settles.push({ id, state, reply }); },
    },
  });

  await bridge.consume([voiceDm(1)]);
  await bridge.settled();
  await bridge.consume([dm(2, "yes")]);
  await bridge.settled();

  assert.ok(settles.some((s) => s.state === "confirmed"), "the typed yes still settles confirmed");
  assert.ok(!settles.some((s) => s.state === "answered"), "an undelivered reply must never settle as answered");
});

/* ------------------------------------------------------------------ *
 * 6. The deferred queue is a bounded FIFO, not a single overwritten row
 * ------------------------------------------------------------------ */

test("bridge: two turns parked in the same drain both resume, in order", async () => {
  const store = memoryStore();
  const config = tempConfig();
  const activity = await activityFor(config);
  const sent: string[] = [];
  const asked: string[] = [];
  let outOfQuota = true;
  const bridge = new TelegramBridge(config, activity, store, {
    think: async (prompt) => {
      asked.push(prompt);
      if (outOfQuota) throw Object.assign(new Error("every provider is out of quota"), { deferrable: true });
      return `answered: ${prompt}`;
    },
    send: async (_config, text) => { sent.push(text); return true; },
    fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
  });

  // Both m1 and m2 hit the quota wall inside the SAME drain — the single-row deferred
  // slot used to let the second parked turn silently overwrite the first.
  await bridge.consume([dm(1, "first ask"), dm(2, "second ask")]);
  await bridge.settled();
  assert.equal(bridge.stats().deferredByLimit, 2, "both turns are parked, not just the last one");

  outOfQuota = false;
  await bridge.consume([dm(3, "third ask")]);
  await bridge.settled();

  assert.deepEqual(
    asked,
    ["first ask", "second ask", "first ask", "second ask", "third ask"],
    "both parked turns resume in the order they were asked, ahead of the newest message",
  );
  assert.equal(bridge.stats().resumed, 2);
  assert.ok(!store.map.get("bridge:deferredTurn"), "the row is cleared once every parked turn is taken");
});

/* ------------------------------------------------------------------ *
 * 7. Overflow never sacrifices a resumed turn
 * ------------------------------------------------------------------ */

test("bridge: a resumed turn survives an overflow that would otherwise drop it", async () => {
  const store = memoryStore();
  // Pre-load a parked turn as the FIFO the fix expects (also exercises the legacy
  // single-object read path when written as a bare object instead of an array).
  store.map.set("bridge:deferredTurn", JSON.stringify({ updateId: 0, kind: "text", text: "resumed ask" }));
  const config = tempConfig();
  const activity = await activityFor(config);
  const asked: string[] = [];
  const bridge = new TelegramBridge(config, activity, store, {
    think: async (prompt) => { asked.push(prompt); return `ack:${prompt}`; },
    send: async () => true,
    fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
  });

  // 6 new messages arrive in one batch. resumeDeferred() puts the resumed turn at the
  // front before any of them are enqueued, so the FIFO fills to 7 and must drop 2 — the
  // old front-drop policy would have sacrificed the just-resumed turn first.
  await bridge.consume(Array.from({ length: 6 }, (_, index) => dm(index + 1, `m${index + 1}`)));
  await bridge.settled();

  assert.equal(bridge.stats().dropped, 2, "two of the newly arrived messages are dropped, not the resumed one");
  assert.equal(bridge.stats().resumed, 1);
  assert.deepEqual(asked, ["resumed ask", "m3", "m4", "m5", "m6"], "the resumed turn is never sacrificed to overflow");
});

/* ------------------------------------------------------------------ *
 * 8. The drain never stalls in its own closing microtask window
 * ------------------------------------------------------------------ */

test("bridge: a message that lands in the drain's closing window is not stranded until a third message", async () => {
  const store = memoryStore();
  const config = tempConfig();
  const asked: string[] = [];
  const bridge = new TelegramBridge(
    config,
    // A fake activity log removes real filesystem I/O from the chain, so the handful of
    // microtask hops between the loop finishing and its `.finally` running are the ONLY
    // async gaps left — small and fixed enough to land a second `consume()` call inside them.
    { record: async () => undefined } as unknown as ActivityLog,
    store,
    {
      think: async (prompt) => { asked.push(prompt); return `ack:${prompt}`; },
      send: async () => true,
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    },
  );

  let chain = Promise.resolve();
  for (let hop = 0; hop < 5; hop += 1) chain = chain.then(() => undefined);
  const secondConsumed = chain.then(() => { void bridge.consume([dm(2, "m2")]); });

  await bridge.consume([dm(1, "m1")]);
  await bridge.settled();
  await secondConsumed;
  await bridge.settled();

  assert.deepEqual(asked, ["m1", "m2"], "m2 is drained without a third message nudging drain() again");
});

/* ------------------------------------------------------------------ *
 * 9. A delegated research turn keeps its caller's own provider session
 * ------------------------------------------------------------------ */

function fakeMemory(): HenryMemory {
  return { remember: async () => "mem-id" } as unknown as HenryMemory;
}

test("luna: a caller-scoped surface keeps its own research session instead of sharing luna::research", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "henry-luna-surface-"));
  const config = loadConfig(root);
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  const luna = new LunaOrchestrator(config, activity, fakeMemory());
  const calls: Array<{ surface?: string }> = [];
  const runnerStub = {
    run: async (_prompt: string, options: { surface?: string }): Promise<RunResult> => {
      calls.push({ surface: options.surface });
      return { runId: "run-1", provider: "codex", response: "done", exitCode: 0, durationMs: 1, events: [] };
    },
  };
  (luna as unknown as { runner: unknown }).runner = runnerStub;

  await luna.dispatch("research", "look into telegram bridging", {});
  assert.equal(calls[0]?.surface, "luna::research", "no surface still falls back to the shared default");

  await luna.dispatch("research", "look into telegram bridging", { surface: "telegram" });
  assert.equal(calls[1]?.surface, "telegram::research", "a caller-scoped surface gets its OWN research session");

  const handle = luna.dispatchAndReport("deep research on agent queues", { surface: "dashboard-session-1" });
  await handle.completion;
  assert.equal(calls[2]?.surface, "dashboard-session-1::research", "dispatchAndReport forwards the caller's surface too");
});

/* ------------------------------------------------------------------ *
 * 10. Out-of-quota research is reported honestly, and an activity-log
 *     failure after delivery never masquerades as a research failure
 * ------------------------------------------------------------------ */

/** Reaches into runtime.ts's telegramBridge getter for its `think` dep directly, so the
 * test exercises the real dispatch/report closure without going through Telegram's queue,
 * config gating, or a real `sendTelegram` network call. */
function bridgeThink(runtime: HenryRuntime): (prompt: string, report: (text: string) => Promise<boolean>) => Promise<string> {
  return (runtime.telegramBridge as unknown as {
    deps: { think: (prompt: string, report: (text: string) => Promise<boolean>) => Promise<string> };
  }).deps.think;
}

const LONG_RESEARCH_ASK = "Do an in-depth research plan for agent orchestration latency and cite primary sources.";

/** The delegated report lands on its own background chain (real activity-log fs writes,
 * memory recall) after `think()`'s acknowledgement already returned, so tests poll for it
 * instead of guessing a fixed number of microtask ticks. */
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("runtime: an out-of-quota delegated research turn is told plainly, with the reset time, never 'Research failed'", async () => {
  const original = getActiveProfile();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "henry-runtime-quota-"));
  try {
    setActiveProfile("henry");
    const runtime = await HenryRuntime.create(tempRoot);
    const runnerStub = {
      run: async (): Promise<RunResult> => ({
        runId: "run-1", provider: "codex", response: "", exitCode: null, durationMs: 1, events: [],
        limited: true,
        error: "The provider CLI is out of quota: codex (limit) until 2026-09-22T00:00:00.000Z. Earliest reset 2026-09-22T00:00:00.000Z.",
      }),
    };
    (runtime.luna as unknown as { runner: unknown }).runner = runnerStub;
    // Memory recall does real embedding work; stubbed so the test waits on the report,
    // not on an unrelated background computation.
    (runtime.memory as unknown as { remember: () => Promise<string> }).remember = async () => "mem-id";

    const reports: string[] = [];
    const ack = await bridgeThink(runtime)(LONG_RESEARCH_ASK, async (text) => { reports.push(text); return true; });
    assert.equal(ack, "Started — I'll report back.");

    await waitFor(() => reports.length > 0);

    assert.equal(reports.length, 1, "exactly one DM — no separate follow-up");
    assert.match(reports[0], /Codex is out of quota/i);
    assert.match(reports[0], /2026-09-22/, "the reset time parsed from result.error is carried into the DM");
    assert.ok(!/Research failed/i.test(reports[0]), "out of quota is unanswered work, not a failure");

    runtime.close();
  } finally {
    setActiveProfile(original.id);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runtime: an activity-log failure after a delivered research report never sends a bogus 'Research failed' DM", async () => {
  const original = getActiveProfile();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "henry-runtime-activity-"));
  try {
    setActiveProfile("henry");
    const runtime = await HenryRuntime.create(tempRoot);
    const runnerStub = {
      run: async (): Promise<RunResult> => ({
        runId: "run-2", provider: "codex", response: "Here is the research report.", exitCode: 0, durationMs: 1, events: [],
      }),
    };
    (runtime.luna as unknown as { runner: unknown }).runner = runnerStub;
    (runtime.memory as unknown as { remember: () => Promise<string> }).remember = async () => "mem-id";
    // Only the SPECIFIC record call runtime.ts makes AFTER delivering the report fails —
    // Luna's own internal dispatch bookkeeping must keep working, or the dispatch itself
    // would fail before ever producing a report, which is a different (legitimate) failure.
    const originalRecord = runtime.activity.record.bind(runtime.activity);
    (runtime.activity as unknown as { record: typeof runtime.activity.record }).record = async (kind, message, ...rest) => {
      if (message === "Telegram delivered Luna's research report") throw new Error("disk full");
      return originalRecord(kind, message, ...rest);
    };

    const reports: string[] = [];
    await bridgeThink(runtime)(LONG_RESEARCH_ASK, async (text) => { reports.push(text); return true; });

    await waitFor(() => reports.length > 0);
    // Give the (buggy, pre-fix) second "Research failed" follow-up a real chance to arrive.
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.deepEqual(reports, ["Here is the research report."], "only the real report is delivered, never a bogus failure DM");

    runtime.close();
  } finally {
    setActiveProfile(original.id);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
