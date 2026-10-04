import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setActiveProfile } from "../src/profile.ts";
import { HenryAgent } from "../src/agent/henry.ts";
import { loadConfig } from "../src/config.ts";
import type { ActivityLog } from "../src/activity.ts";
import type { HenryMemory } from "../src/memory/engram.ts";
import { HenryRuntime } from "../src/runtime.ts";
import { createTurnEventHandler, researchNoticeLabel, startDashboard } from "../src/dashboard/server.ts";
import { DASHBOARD_HTML } from "../src/dashboard/page.ts";
import { providerLimitLedger } from "../src/providers/limits.ts";
import { publicHarness, tunnel } from "./public-harness.ts";
import type { ProviderEvent } from "../src/types.ts";

setActiveProfile("kelly");

const ev = (parsed: Record<string, unknown>): ProviderEvent => ({ timestamp: "", stream: "stdout", text: "", parsed });
const messageStart = () => ev({ type: "stream_event", event: { type: "message_start" } });
const delta = (text: string) => ev({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const whole = (text: string) => ev({ type: "assistant", message: { content: [{ type: "text", text }] } });
const toolUse = () => ev({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } });
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function isToolStart(parsed: Record<string, unknown> | undefined): boolean {
  const content = (parsed?.message as { content?: Array<{ type?: string }> } | undefined)?.content;
  return parsed?.type === "assistant" && Array.isArray(content) && content.some((block) => block.type === "tool_use");
}

function collect(voiceMode: boolean, events: ProviderEvent[]) {
  const written: Array<{ event: string; data: { text?: string } }> = [];
  let tools = 0;
  const handler = createTurnEventHandler({ voiceMode, write: (event, data) => written.push({ event, data: data as { text?: string } }), onToolStart: () => { tools += 1; }, isToolStart });
  for (const event of events) handler(event);
  return {
    tokens: written.filter((entry) => entry.event === "token").map((entry) => entry.data.text).join(""),
    spoken: written.filter((entry) => entry.event === "spoken").map((entry) => entry.data.text),
    tools,
  };
}

test("Claude text deltas stream once; the repeating whole message is not doubled", () => {
  const out = collect(false, [messageStart(), delta("Two "), delta("suits."), whole("Two suits.")]);
  assert.equal(out.tokens, "Two suits.");
});

test("Claude without partial messages streams the whole message", () => {
  assert.equal(collect(false, [whole("Hello there.")]).tokens, "Hello there.\n");
});

test("Codex agent messages still stream, separated by a blank line", () => {
  const msg = (text: string) => ev({ type: "item.completed", item: { type: "agent_message", text } });
  assert.equal(collect(false, [msg("One."), msg("Two.")]).tokens, "One.\n\n\nTwo.\n");
});

test("spoken fence split across Claude deltas fires one spoken event and never reaches tokens", () => {
  const out = collect(true, [messageStart(), delta("```spo"), delta("ken\nGot it, "), delta("1,700 rupees.\n``"), delta("`\nTwo suits, Rs 1,700."), whole("```spoken\nGot it, 1,700 rupees.\n```\nTwo suits, Rs 1,700.")]);
  assert.deepEqual(out.spoken, ["Got it, 1,700 rupees."]);
  assert.equal(out.tokens.trim(), "Two suits, Rs 1,700.");
  assert.doesNotMatch(out.tokens, /spoken|```/);
});

test("the fence may open a later Claude message after commentary and a tool call", () => {
  const out = collect(true, [
    messageStart(), delta("Checking the catalogue."), whole("Checking the catalogue."), toolUse(),
    messageStart(), delta("```spoken\nTotal is 500 rupees.\n```\nDone."), whole("```spoken\nTotal is 500 rupees.\n```\nDone."),
  ]);
  assert.deepEqual(out.spoken, ["Total is 500 rupees."]);
  assert.match(out.tokens, /^Checking the catalogue\.\n\nDone\.$/);
  assert.equal(out.tools, 1, "gathering fires from a Claude tool_use");
});

test("tool starts only raise gathering on voice turns", () => {
  assert.equal(collect(false, [toolUse()]).tools, 0);
});

test("research notice names the active provider and model", () => {
  assert.equal(researchNoticeLabel({ provider: "claude", claudeModel: "sonnet", codexModel: "gpt-x" }), "Claude sonnet");
  assert.equal(researchNoticeLabel({ provider: "codex", claudeModel: "sonnet", codexModel: "gpt-x" }), "Codex gpt-x");
});

test("dashboard page keys the quota card and pills on the active provider", () => {
  assert.match(DASHBOARD_HTML, /function activeProv\(\)/);
  assert.match(DASHBOARD_HTML, /limits\[activeProv\(\)\]/);
  assert.doesNotMatch(DASHBOARD_HTML, /Codex window|Codex parked|Codex quota OK|u\.limits\.codex|lim\.codex\?/);
});

async function kellyServer(provider: "claude" | "codex") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-claude-dash-"));
  fs.cpSync(path.join(process.cwd(), "workflows"), path.join(root, "workflows"), { recursive: true });
  const runtime = await HenryRuntime.create(root);
  assert.equal(runtime.config.profileId, "kelly");
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";
  runtime.config.provider = provider;
  const calls: Array<{ prompt: string; provider?: string }> = [];
  let script: ProviderEvent[] = [];
  (runtime.agent as unknown as { run: unknown }).run = async (prompt: string, options: { provider?: string; onEvent?: (event: ProviderEvent) => void }) => {
    calls.push({ prompt, provider: options.provider });
    for (const event of script) options.onEvent?.(event);
    return { runId: "r1", provider, response: "ok", exitCode: 0, durationMs: 1, events: [] };
  };
  const server = startDashboard(runtime);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    base: `http://127.0.0.1:${address.port}`, runtime, calls,
    script: (events: ProviderEvent[]) => { script = events; },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); runtime.close(); },
  };
}

function sseEvents(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  return text.split("\n\n").filter(Boolean).map((block) => {
    const event = /^event: (.*)$/m.exec(block)?.[1] ?? "";
    const data = /^data: (.*)$/m.exec(block)?.[1];
    return { event, data: data ? JSON.parse(data) as Record<string, unknown> : {} };
  });
}

test("Kelly counter turn on Claude streams deltas once, fires spoken and gathering", async () => {
  const server = await kellyServer("claude");
  try {
    server.script([
      messageStart(), delta("Looking."), whole("Looking."), toolUse(),
      messageStart(), delta("```spoken\nQuote ready.\n```\nTwo suits, Rs 1,700."), whole("```spoken\nQuote ready.\n```\nTwo suits, Rs 1,700."),
    ]);
    const events = sseEvents(await (await fetch(`${server.base}/api/chat/send`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "how are you doing today my friend", voice: true }),
    })).text());
    const tokens = events.filter((e) => e.event === "token").map((e) => e.data.text).join("");
    assert.equal(tokens, "Looking.\n\nTwo suits, Rs 1,700.");
    assert.deepEqual(events.filter((e) => e.event === "spoken").map((e) => e.data.text), ["Quote ready."]);
    assert.deepEqual(events.filter((e) => e.event === "gathering").map((e) => e.data.reason), ["tool"]);
  } finally { await server.close(); }
});

test("Kelly web chat on Claude streams tokens without voice", async () => {
  const server = await kellyServer("claude");
  try {
    server.script([messageStart(), delta("Hel"), delta("lo."), whole("Hello.")]);
    const events = sseEvents(await (await fetch(`${server.base}/api/chat/send`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "how are you doing today my friend" }),
    })).text());
    assert.equal(events.filter((e) => e.event === "token").map((e) => e.data.text).join(""), "Hello.");
    assert.equal(events.some((e) => e.event === "gathering" || e.event === "spoken"), false);
  } finally { await server.close(); }
});

for (const provider of ["claude", "codex"] as const) {
  test(`Kelly attachment turn runs on the configured provider (${provider}); notice only on codex`, async () => {
    const server = await kellyServer(provider);
    try {
      const upload = await fetch(`${server.base}/api/attachments`, { method: "POST", headers: { "content-type": "image/png", "x-filename": "s.png" }, body: PNG });
      const { attachment } = await upload.json() as { attachment: { id: string; name: string } };
      const stream = await (await fetch(`${server.base}/api/chat/send`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "what does this say?", attachments: [{ id: attachment.id, name: attachment.name }] }),
      })).text();
      assert.equal(server.calls[0].provider, undefined, "no provider pin for Kelly");
      assert.match(server.calls[0].prompt, /attached images/);
      if (provider === "codex") assert.match(stream, /Codex can't read images/);
      else assert.doesNotMatch(stream, /event: notice/);
    } finally { await server.close(); }
  });
}

test("public brainReady and provider follow the configured provider", async () => {
  const h = await publicHarness();
  try {
    h.runtime.config.provider = "claude";
    const ready = async () => ((await (await fetch(`${h.base}/api/public/heartbeat`, { headers: tunnel() })).json()) as { brain: { ready: boolean } }).brain.ready;
    assert.equal(await ready(), true);
    const ledger = providerLimitLedger();
    assert.ok(ledger);
    const until = new Date(Date.now() + 30 * 60_000).toISOString();
    ledger.markLimited("codex", { limited: true, kind: "limit", reason: "test", resetAt: until });
    assert.equal(await ready(), true, "a parked codex does not affect a claude brain");
    ledger.markLimited("claude", { limited: true, kind: "limit", reason: "test", resetAt: until });
    assert.equal(await ready(), false, "a parked claude does");
    h.runtime.config.provider = "codex";
    ledger.clear("codex");
    assert.equal(await ready(), true);
    ledger.clear();
  } finally { await h.close(); }
});

test("Kelly's prompt is provider-neutral and identical across providers; deep work reaches t2 on Claude", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "kelly-prompt-neutral-"));
  await fsp.writeFile(path.join(root, "soul.md"), "Soul.", "utf8");
  await fsp.writeFile(path.join(root, "personality.md"), "Persona.", "utf8");
  const memory = { context: async () => "", remember: async () => undefined } as unknown as HenryMemory;
  const activity = { record: async () => undefined } as unknown as ActivityLog;
  const agent = new HenryAgent(loadConfig(root), activity, memory);
  const claude = await agent.buildPrompt("Explain the quote flow", "a", true, "claude");
  const codex = await agent.buildPrompt("Explain the quote flow", "b", true, "codex");
  assert.equal(claude, codex);
  assert.doesNotMatch(claude, /Codex-only|cheap Codex|Never use Claude|exposed to Codex|only on Codex/);
  assert.match(claude, /mcp__kelly_excel__\*/);
  assert.doesNotMatch(await agent.buildPrompt("Explain the quote flow", "c", false, "claude"), /Codex-only/);

  const tiers: Array<string | undefined> = [];
  (agent as unknown as { runner: unknown }).runner = {
    acquireSession: () => undefined,
    run: async (_p: string, o: { tier?: string }) => { tiers.push(o.tier); return { runId: "x", provider: "claude", response: "", exitCode: 0, durationMs: 1, events: [] }; },
  };
  await agent.run("investigate the root cause of this production incident", { provider: "claude" });
  await agent.run("what products do you have", { provider: "claude" });
  await agent.run("hi", { provider: "claude" });
  assert.deepEqual(tiers, ["t2", "t1", "t0"]);
});
