import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTradeId, tradePack } from "../src/trade/index.ts";
import { setActiveProfile } from "../src/profile.ts";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { HenryAgent } from "../src/agent/henry.ts";
import type { HenryMemory } from "../src/memory/engram.ts";
import { HenryRuntime } from "../src/runtime.ts";
import { startDashboard } from "../src/dashboard/server.ts";

test("parseTradeId defaults to electrical, accepts valid ids, and rejects unknown ones", () => {
  assert.equal(parseTradeId(undefined), "electrical");
  assert.equal(parseTradeId(""), "electrical");
  assert.equal(parseTradeId("electrical"), "electrical");
  assert.equal(parseTradeId("boutique"), "boutique");
  assert.throws(() => parseTradeId("plumbing"), /Unknown trade "plumbing"/);
});

test("both trade packs carry non-empty prompt blocks and required fields", () => {
  for (const id of ["electrical", "boutique"] as const) {
    const pack = tradePack(id);
    assert.equal(pack.id, id);
    assert.ok(pack.displayName.length > 0);
    assert.ok(pack.defaultShopName.length > 0);
    assert.ok(pack.promptBlock.trim().length > 0);
    assert.ok(pack.quoteIntake.length > 0);
    assert.ok(pack.setupQuestions.length >= 3);
    assert.ok(pack.accent.copper && pack.accent.copper2 && pack.accent.dim);
  }
});

test("both trade packs carry a non-empty voice vocabulary, and boutique declares aliases for every gallery category and tag", () => {
  for (const id of ["electrical", "boutique"] as const) {
    const pack = tradePack(id);
    assert.ok(pack.vocabulary.length > 0, `${id} vocabulary must not be empty`);
  }
  const boutique = tradePack("boutique");
  assert.ok(boutique.vocabulary.includes("lehenga"));
  assert.ok(boutique.vocabulary.includes("saree"));
  for (const category of boutique.galleryCategories) {
    assert.ok(boutique.aliases[category]?.length, `expected aliases for category "${category}"`);
  }
  assert.ok(boutique.aliases.latest?.length);
  assert.ok(boutique.aliases.trending?.length);
});

test("boutique promptBlock asks for garment, fabric and delivery, and grounds pricing in the rate card", () => {
  const block = tradePack("boutique").promptBlock;
  assert.match(block, /rate card/);
  assert.match(block, /garment/);
  assert.match(block, /fabric/);
  assert.match(block, /delivery date/);
});

test("electrical promptBlock never mentions stitching", () => {
  assert.doesNotMatch(tradePack("electrical").promptBlock, /stitch/i);
});

test("config reads KELLY_TRADE and KELLY_SHOP_NAME, and defaults per pack", async () => {
  setActiveProfile("kelly");
  const savedTrade = process.env.KELLY_TRADE;
  const savedShop = process.env.KELLY_SHOP_NAME;
  try {
    delete process.env.KELLY_TRADE;
    delete process.env.KELLY_SHOP_NAME;
    const root1 = await fs.promises.mkdtemp(path.join(os.tmpdir(), "kelly-trade-config-"));
    const defaultConfig = loadConfig(root1);
    assert.equal(defaultConfig.trade, "electrical");
    assert.equal(defaultConfig.shopName, tradePack("electrical").defaultShopName);

    process.env.KELLY_TRADE = "boutique";
    const root2 = await fs.promises.mkdtemp(path.join(os.tmpdir(), "kelly-trade-config-"));
    const boutiqueConfig = loadConfig(root2);
    assert.equal(boutiqueConfig.trade, "boutique");
    assert.equal(boutiqueConfig.shopName, "She Fashion House");

    process.env.KELLY_SHOP_NAME = "Custom Boutique";
    const root3 = await fs.promises.mkdtemp(path.join(os.tmpdir(), "kelly-trade-config-"));
    const customConfig = loadConfig(root3);
    assert.equal(customConfig.shopName, "Custom Boutique");
  } finally {
    if (savedTrade === undefined) delete process.env.KELLY_TRADE; else process.env.KELLY_TRADE = savedTrade;
    if (savedShop === undefined) delete process.env.KELLY_SHOP_NAME; else process.env.KELLY_SHOP_NAME = savedShop;
  }
});

test("fresh system prompt for a boutique-configured Kelly contains the boutique block, not the electrical sentences", async () => {
  setActiveProfile("kelly");
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "kelly-trade-prompt-"));
  const config = loadConfig(root);
  config.dataDir = path.join(root, "data");
  config.trade = "boutique";
  config.shopName = "She Fashion House";
  await fs.promises.writeFile(path.join(root, "soul.md"), "test soul");
  await fs.promises.writeFile(path.join(root, "personality.md"), "test personality");
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  const memory = { context: async () => "" } as unknown as HenryMemory;
  const agent = new HenryAgent(config, activity, memory, undefined, undefined);
  const prompt = await agent.buildPrompt("What garments do you stitch?", "run-boutique", true, "codex");
  assert.match(prompt, /TRADE: Ladies' boutique\. SHOP: She Fashion House\./);
  assert.match(prompt, /rate card/);
  assert.match(prompt, /garment/);
  assert.doesNotMatch(prompt, /multi-brand quotations/);
  await agent.flushMemoryCaptures();
});

async function withBoutiqueDashboard(run: (base: string, runtime: HenryRuntime) => Promise<void>): Promise<void> {
  const savedTrade = process.env.KELLY_TRADE;
  const savedShop = process.env.KELLY_SHOP_NAME;
  process.env.KELLY_TRADE = "boutique";
  delete process.env.KELLY_SHOP_NAME;
  setActiveProfile("kelly");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-trade-dashboard-"));
  const runtime = await HenryRuntime.create(tempRoot);
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";
  runtime.config.dashboardToken = "trade-test-owner-token";
  fs.mkdirSync(path.dirname(runtime.config.settingsPath), { recursive: true });
  fs.writeFileSync(runtime.config.settingsPath, JSON.stringify({ "dashboard.auth.localAdminBypass": false }));
  const server = startDashboard(runtime);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try { await run(`http://127.0.0.1:${address.port}`, runtime); }
  finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    runtime.close();
    if (savedTrade === undefined) delete process.env.KELLY_TRADE; else process.env.KELLY_TRADE = savedTrade;
    if (savedShop === undefined) delete process.env.KELLY_SHOP_NAME; else process.env.KELLY_SHOP_NAME = savedShop;
  }
}

test("/voice is served with the boutique shop name and /api/status carries trade", async () => {
  await withBoutiqueDashboard(async (base) => {
    const auth = { authorization: "Bearer trade-test-owner-token" };
    const page = await fetch(`${base}/voice`, { headers: auth });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<title>She Fashion House · counter<\/title>/);
    assert.match(html, /She Fashion House <span class="muted">\/ counter<\/span>/);
    assert.doesNotMatch(html, /<!--KELLY_SHOP-->|<!--KELLY_MARK-->|<!--KELLY_ACCENT-->/);

    const status = await fetch(`${base}/api/status`, { headers: auth }).then(response => response.json()) as { trade: { id: string; displayName: string; shopName: string; accent: Record<string, string> } };
    assert.equal(status.trade.id, "boutique");
    assert.equal(status.trade.shopName, "She Fashion House");
    assert.equal(status.trade.displayName, "Ladies' boutique");
    assert.ok(status.trade.accent.copper);
  });
});

test("voiceMode instruction answers in clear English and never asks for a Hindi/English mix", async () => {
  await withBoutiqueDashboard(async (base, runtime) => {
    let providerPrompt = "";
    (runtime.agent as unknown as { run: unknown }).run = async (prompt: string) => {
      providerPrompt = prompt;
      return { runId: "trade-voice", provider: "codex", response: "noted", exitCode: 0, durationMs: 1, events: [] };
    };
    const response = await fetch(`${base}/api/chat/send`, {
      method: "POST",
      headers: { authorization: "Bearer trade-test-owner-token", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Ek blouse ka rate kya hai", voice: true }),
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.match(providerPrompt, /always answer in clear, simple English/);
    assert.doesNotMatch(providerPrompt, /Hindi\/English mix/);
    assert.match(providerPrompt, /published rate card and deterministic commerce calculations/);
  });
});
