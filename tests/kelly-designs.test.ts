import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { setActiveProfile } from "../src/profile.ts";
import { HenryRuntime } from "../src/runtime.ts";
import { startDashboard } from "../src/dashboard/server.ts";
import { DesignStore } from "../src/designs/store.ts";
import { runDesignsCommand } from "../src/designs/commands.ts";
import { DesignService } from "../src/designs/rag.ts";
import { parseDesignsBlock } from "../src/designs/block.ts";
import { sendTelegramPhotoAlbum } from "../src/telegram/media.ts";
import { encodeSolidPng } from "../src/designs/png.ts";

const CATEGORIES = ["suit", "saree", "lehenga", "blouse", "kurti", "gown", "dupatta"];
const TAGS = ["trending", "latest", "bridal", "party", "festive", "casual", "custom-order"];

function tempDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "kelly-designs-")); }
function png(r = 200, g = 100, b = 100): Buffer { return encodeSolidPng(40, 50, { r, g, b }); }

const execFile = promisify(execFileCallback);
const repoRoot = process.cwd();
const cliEntry = path.join(repoRoot, "src/cli.ts");

async function runCli(args: string[], env: NodeJS.ProcessEnv) {
  try {
    const result = await execFile(process.execPath, ["--import", "tsx/esm", cliEntry, ...args], { cwd: repoRoot, env, timeout: 20_000, maxBuffer: 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const result = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { code: result.code ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}

/* ------------------------------------------------------------------ store ------------------------------------------------------------------ */

test("DesignStore.add validates category and tags, sniffs magic bytes, and rejects oversize", () => {
  const store = new DesignStore(tempDir(), CATEGORIES, TAGS);
  try {
    assert.throws(() => store.add({ bytes: png(), category: "shoes" }), /Unknown design category/);
    assert.throws(() => store.add({ bytes: png(), category: "saree", tags: ["not-a-real-tag"] }), /Unknown design tag "not-a-real-tag"/);
    assert.throws(() => store.add({ bytes: Buffer.from("not an image"), category: "saree" }), /Only images are accepted/);
    const { design } = store.add({ bytes: png(), category: "saree", tags: ["trending", "TRENDING"], caption: "Banarasi silk" });
    assert.match(design.id, /^dsg_[0-9a-f]{16}$/);
    assert.equal(design.category, "saree");
    assert.deepEqual(design.tags, ["trending"]);
    assert.equal(design.status, "active");
    assert.equal(design.ext, "png");
    assert.ok(fs.existsSync(store.imagePath(design.id)!));
  } finally { store.close(); }
});

test("DesignStore.add deduplicates by sha256", () => {
  const store = new DesignStore(tempDir(), CATEGORIES, TAGS);
  try {
    const bytes = png(1, 2, 3);
    const first = store.add({ bytes, category: "saree" });
    const second = store.add({ bytes, category: "saree" });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(first.design.id, second.design.id);
    assert.equal(store.stats().total, 1);
  } finally { store.close(); }
});

test("DesignStore.list filters by category, tags, text, latest and trending", () => {
  const store = new DesignStore(tempDir(), CATEGORIES, TAGS);
  try {
    const a = store.add({ bytes: png(10, 10, 10), category: "saree", tags: ["trending"], caption: "Banarasi silk saree" }).design;
    const b = store.add({ bytes: png(20, 20, 20), category: "lehenga", tags: ["bridal"], caption: "Bridal lehenga" }).design;
    store.add({ bytes: png(30, 30, 30), category: "saree", tags: ["casual"], caption: "Cotton saree" });

    assert.equal(store.list({ category: "lehenga" }).length, 1);
    assert.equal(store.list({ tags: ["bridal"] })[0].id, b.id);
    assert.equal(store.list({ text: "banarasi" })[0].id, a.id);
    assert.equal(store.list({ latest: true }).length, 3, "everything just added is within the 30-day latest window");

    // Trending: tagged "trending" OR shown_count > 0, unioned, ordered by shown_count desc.
    assert.equal(store.list({ trending: true }).some((d) => d.id === a.id), true, "tagged trending");
    store.markShown([b.id]);
    const trending = store.list({ trending: true });
    assert.equal(trending.some((d) => d.id === b.id), true, "shown_count > 0 also counts as trending");
    assert.equal(trending[0].id, b.id, "highest shown_count sorts first");
  } finally { store.close(); }
});

test("DesignStore.markShown increments shown_count and hide() soft-deletes", () => {
  const store = new DesignStore(tempDir(), CATEGORIES, TAGS);
  try {
    const { design } = store.add({ bytes: png(), category: "gown" });
    store.markShown([design.id, design.id]);
    assert.equal(store.get(design.id)!.shownCount, 2);
    const hidden = store.hide(design.id);
    assert.equal(hidden.status, "hidden");
    assert.equal(store.list({}).length, 0, "hidden designs never appear in list()");
    assert.ok(store.get(design.id), "hide keeps the row, not a delete");
  } finally { store.close(); }
});

/* ------------------------------------------------------------------ CLI ------------------------------------------------------------------ */

test("kelly designs search --json returns the documented shape", async () => {
  const service = new DesignService({ dataDir: tempDir() } as never, CATEGORIES, TAGS);
  try {
    // Three+ SQL matches so DesignService.find never falls through to the semantic lane
    // (which would need the local embedding model) — that lane has its own coverage above.
    const { design } = service.store.add({ bytes: png(), category: "kurti", tags: ["latest"], caption: "Printed cotton kurti" });
    service.store.add({ bytes: png(1, 1, 1), category: "kurti", tags: ["latest"], caption: "Another kurti design" });
    service.store.add({ bytes: png(2, 2, 2), category: "kurti", tags: ["latest"], caption: "A third kurti design" });
    const result = await runDesignsCommand(service, ["search", "kurti", "--json"]) as { designs: Array<Record<string, unknown>> };
    assert.ok(Array.isArray(result.designs));
    const row = result.designs.find((d) => d.id === design.id);
    assert.ok(row, "the added design is found by category/text search");
    assert.equal(row!.url, `/api/designs/${design.id}/image`);
    for (const key of ["id", "category", "tags", "caption", "colours", "fabric", "occasion", "priceBand", "url"]) {
      assert.ok(key in row!, `missing ${key}`);
    }
  } finally { service.close(); }
});

test("kelly designs list --json and stats", async () => {
  const service = new DesignService({ dataDir: tempDir() } as never, CATEGORIES, TAGS);
  try {
    service.store.add({ bytes: png(1, 1, 1), category: "blouse", tags: ["trending"] });
    service.store.add({ bytes: png(2, 2, 2), category: "blouse", tags: ["party"] });
    const listed = await runDesignsCommand(service, ["list", "--category", "blouse", "--json"]) as { designs: unknown[] };
    assert.equal(listed.designs.length, 2);
    const stats = await runDesignsCommand(service, ["stats"]) as { categories: Record<string, number>; total: number };
    assert.equal(stats.categories.blouse, 2);
    assert.equal(stats.total, 2);
  } finally { service.close(); }
});

/* ------------------------------------------------------------------ DesignService.find ------------------------------------------------------------------ */

test('find("trending sarees") returns the trending saree and no other category', async () => {
  const service = new DesignService({ dataDir: tempDir() } as never, CATEGORIES, TAGS);
  try {
    const { design: trendingSaree } = service.store.add({ bytes: png(1, 1, 1), category: "saree", tags: ["trending"], caption: "Banarasi silk saree" });
    service.store.add({ bytes: png(2, 2, 2), category: "saree", tags: ["casual"], caption: "Cotton saree, everyday wear" });
    service.store.add({ bytes: png(3, 3, 3), category: "lehenga", tags: ["trending"], caption: "Trending bridal lehenga" });

    const results = await service.find("trending sarees");
    assert.ok(results.some((d) => d.id === trendingSaree.id), "the trending saree is returned");
    assert.ok(results.every((d) => d.category === "saree"), "only sarees come back, never the trending lehenga");
  } finally { service.close(); }
});

test('find("show me bridal lehengas") returns lehengas tagged bridal', async () => {
  const service = new DesignService({ dataDir: tempDir() } as never, CATEGORIES, TAGS);
  try {
    const { design: bridalLehenga } = service.store.add({ bytes: png(1, 1, 1), category: "lehenga", tags: ["bridal"], caption: "Bridal lehenga, heavy work" });
    service.store.add({ bytes: png(2, 2, 2), category: "lehenga", tags: ["party"], caption: "Party lehenga" });
    service.store.add({ bytes: png(3, 3, 3), category: "saree", tags: ["bridal"], caption: "Bridal saree" });

    const results = await service.find("show me bridal lehengas");
    assert.ok(results.some((d) => d.id === bridalLehenga.id));
    assert.ok(results.every((d) => d.category === "lehenga" && d.tags.includes("bridal")));
  } finally { service.close(); }
});

test('find("red saree") with no red saree returns the sarees (widened, not empty)', async () => {
  const service = new DesignService({ dataDir: tempDir() } as never, CATEGORIES, TAGS);
  try {
    const { design: blueSaree } = service.store.add({ bytes: png(1, 1, 1), category: "saree", tags: ["casual"], caption: "Blue cotton saree", colours: ["blue"] });
    service.store.add({ bytes: png(2, 2, 2), category: "saree", tags: ["festive"], caption: "Green silk saree", colours: ["green"] });
    service.store.add({ bytes: png(3, 3, 3), category: "kurti", tags: ["casual"], caption: "Printed kurti" });

    const results = await service.find("red saree");
    assert.ok(results.length > 0, "no red saree exists, but the category still widens instead of coming back empty");
    assert.ok(results.some((d) => d.id === blueSaree.id));
    assert.ok(results.every((d) => d.category === "saree"));
  } finally { service.close(); }
});

test('find("latest kurtis") honours the 30-day window', async () => {
  const service = new DesignService({ dataDir: tempDir() } as never, CATEGORIES, TAGS);
  try {
    const { design: freshKurti } = service.store.add({ bytes: png(1, 1, 1), category: "kurti", tags: ["latest"], caption: "New printed kurti" });
    // Backdate a second kurti past the 30-day latest window directly in the DB.
    const old = service.store.add({ bytes: png(2, 2, 2), category: "kurti", tags: ["casual"], caption: "Old kurti design" }).design;
    const db = (service.store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db;
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE designs SET added_at = ? WHERE id = ?").run(oldDate, old.id);

    const results = await service.find("latest kurtis");
    assert.ok(results.some((d) => d.id === freshKurti.id));
    assert.ok(results.every((d) => d.id !== old.id), "a 40-day-old kurti falls outside the 30-day latest window");
  } finally { service.close(); }
});

test("designs stats against an explicit absolute KELLY_DATA_DIR sees rows written by a DesignStore opened on the same dir (guards the CLI/server data-dir split)", async () => {
  const dataDir = tempDir();
  const store = new DesignStore(dataDir, CATEGORIES, TAGS);
  try {
    store.add({ bytes: png(1, 1, 1), category: "saree", tags: ["trending"], caption: "Banarasi silk saree" });
    store.add({ bytes: png(2, 2, 2), category: "lehenga", tags: ["bridal"], caption: "Bridal lehenga" });
  } finally { store.close(); }

  // Same env shape the runtime's own spawned shell inherits: AGENT_PROFILE=kelly plus an
  // explicit absolute KELLY_DATA_DIR — not the launcher (bin/kelly.mjs), which would set the
  // profile itself. Without src/cli.ts setting the active profile from AGENT_PROFILE, the CLI
  // silently falls back to the "henry" profile, reads HENRY_DATA_DIR instead of KELLY_DATA_DIR,
  // and reports an empty store even though the dashboard/server sees every row.
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_PROFILE: "kelly", KELLY_TRADE: "boutique", KELLY_DATA_DIR: dataDir };
  const result = await runCli(["designs", "stats"], env);
  assert.equal(result.code, 0, result.stderr);
  const stats = JSON.parse(result.stdout) as { total: number; categories: Record<string, number> };
  assert.equal(stats.total, 2, "the CLI process sees the same store the DesignStore wrote to");
  assert.equal(stats.categories.saree, 1);
  assert.equal(stats.categories.lehenga, 1);
});

/* ------------------------------------------------------------------ block parsing ------------------------------------------------------------------ */

test("parseDesignsBlock reads a fenced JSON array, a {ids:[...]} object, and a DESIGNS: line, capped at 8", () => {
  const idFor = (n: number) => `dsg_${n.toString(16).padStart(16, "0")}`;
  const ids = Array.from({ length: 10 }, (_, i) => idFor(i + 1));
  const fenced = `Here you go.\n\n\`\`\`designs\n${JSON.stringify(ids)}\n\`\`\`\n`;
  const parsedFence = parseDesignsBlock(fenced)!;
  assert.equal(parsedFence.ids.length, 8, "capped at 8");
  assert.equal(parsedFence.text, "Here you go.");

  const objectForm = `Shown below.\n\`\`\`designs\n{"ids": ${JSON.stringify(ids.slice(0, 2))}}\n\`\`\``;
  assert.deepEqual(parseDesignsBlock(objectForm)!.ids, ids.slice(0, 2));

  const line = `Take a look.\nDESIGNS: ${ids[0]}, ${ids[1]}, not-a-valid-id`;
  const parsedLine = parseDesignsBlock(line)!;
  assert.deepEqual(parsedLine.ids, [ids[0], ids[1]]);
  assert.equal(parsedLine.text, "Take a look.");

  assert.equal(parseDesignsBlock("no block here at all"), undefined);
});

/* ------------------------------------------------------------------ routes ------------------------------------------------------------------ */

async function withBoutiqueDashboard(run: (base: string, runtime: HenryRuntime) => Promise<void>): Promise<void> {
  const savedTrade = process.env.KELLY_TRADE;
  const savedDataDir = process.env.HENRY_DATA_DIR;
  process.env.KELLY_TRADE = "boutique";
  setActiveProfile("kelly");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-designs-dashboard-"));
  // auth.ts's user store is keyed off HENRY_DATA_DIR directly (not the runtime config), so
  // each dashboard instance needs its own value to avoid "user already exists" collisions
  // across tests in the same process (see tests/kelly-remote-auth.test.ts's own harness).
  process.env.HENRY_DATA_DIR = path.join(tempRoot, "data");
  const runtime = await HenryRuntime.create(tempRoot);
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";
  runtime.config.dashboardToken = "designs-test-owner-token";
  fs.mkdirSync(path.dirname(runtime.config.settingsPath), { recursive: true });
  fs.writeFileSync(runtime.config.settingsPath, JSON.stringify({ "dashboard.auth.localAdminBypass": false }));
  const { createUser } = await import("../src/dashboard/auth.ts");
  createUser({ username: "counter", password: "counter-password-1", role: "counter" });
  const server = startDashboard(runtime);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try { await run(`http://127.0.0.1:${address.port}`, runtime); }
  finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    runtime.close();
    if (savedTrade === undefined) delete process.env.KELLY_TRADE; else process.env.KELLY_TRADE = savedTrade;
    if (savedDataDir === undefined) delete process.env.HENRY_DATA_DIR; else process.env.HENRY_DATA_DIR = savedDataDir;
  }
}

async function counterCookie(base: string): Promise<string> {
  const response = await fetch(`${base}/login`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "counter", password: "counter-password-1" }).toString(), redirect: "manual",
  });
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie);
  return cookie!.split(";")[0];
}

test("counter can GET the design list and image, but every write route 403s", async () => {
  await withBoutiqueDashboard(async (base, runtime) => {
    const admin = { authorization: "Bearer designs-test-owner-token" };
    const upload = await fetch(`${base}/api/designs`, {
      method: "POST", headers: { ...admin, "content-type": "image/png", "x-kelly-design-category": "saree" }, body: png() as unknown as BodyInit,
    });
    assert.equal(upload.status, 200);
    const { design } = await upload.json() as { design: { id: string } };

    const cookie = await counterCookie(base);
    const list = await fetch(`${base}/api/designs`, { headers: { cookie } });
    assert.equal(list.status, 200);
    const listBody = await list.json() as { designs: Array<{ id: string }> };
    assert.ok(listBody.designs.some((d) => d.id === design.id));

    const image = await fetch(`${base}/api/designs/${design.id}/image`, { headers: { cookie } });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");

    const post = await fetch(`${base}/api/designs`, { method: "POST", headers: { cookie, "x-kelly-design-category": "saree" }, body: png() as unknown as BodyInit });
    assert.equal(post.status, 403);
    const patch = await fetch(`${base}/api/designs/${design.id}`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ caption: "nope" }) });
    assert.equal(patch.status, 403);
    const del = await fetch(`${base}/api/designs/${design.id}`, { method: "DELETE", headers: { cookie } });
    assert.equal(del.status, 403);
    const stats = await fetch(`${base}/api/designs/stats`, { headers: { cookie } });
    assert.equal(stats.status, 403);
    void runtime;
  });
});

test("admin POST stores a file with the header fields, PATCH updates it, and an unknown tag is rejected", async () => {
  await withBoutiqueDashboard(async (base) => {
    const admin = { authorization: "Bearer designs-test-owner-token" };
    const upload = await fetch(`${base}/api/designs`, {
      method: "POST",
      headers: { ...admin, "content-type": "image/png", "x-kelly-design-category": "lehenga", "x-kelly-design-tags": "bridal,trending", "x-kelly-design-caption": encodeURIComponent("Bridal lehenga") },
      body: png(5, 5, 5) as unknown as BodyInit,
    });
    assert.equal(upload.status, 200);
    const { design } = await upload.json() as { design: { id: string; caption: string; tags: string[] } };
    assert.equal(design.caption, "Bridal lehenga");
    assert.deepEqual(design.tags.sort(), ["bridal", "trending"]);

    const patch = await fetch(`${base}/api/designs/${design.id}`, {
      method: "PATCH", headers: { ...admin, "content-type": "application/json" }, body: JSON.stringify({ caption: "Updated caption" }),
    });
    assert.equal(patch.status, 200);
    assert.equal((await patch.json() as { design: { caption: string } }).design.caption, "Updated caption");

    const badTag = await fetch(`${base}/api/designs`, {
      method: "POST", headers: { ...admin, "content-type": "image/png", "x-kelly-design-category": "saree", "x-kelly-design-tags": "not-a-real-tag" }, body: png(9, 9, 9) as unknown as BodyInit,
    });
    assert.equal(badTag.status, 400);
    assert.match((await badTag.json() as { error: string }).error, /Unknown design tag/);
  });
});

test("a ```designs block is stripped from the reply and emitted as an SSE `designs` event", async () => {
  await withBoutiqueDashboard(async (base, runtime) => {
    const { design } = runtime.designs.store.add({ bytes: png(7, 7, 7), category: "saree", tags: ["trending"], caption: "Banarasi silk saree" });
    (runtime.agent as unknown as { run: unknown }).run = async () => ({
      runId: "designs-turn", provider: "codex", exitCode: 0, durationMs: 1, events: [],
      response: `Here are trending sarees.\n\n\`\`\`designs\n["${design.id}"]\n\`\`\``,
    });
    const response = await fetch(`${base}/api/chat/send`, {
      method: "POST", headers: { authorization: "Bearer designs-test-owner-token", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "show me trending sarees" }),
    });
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.match(stream, /event: designs/);
    assert.match(stream, new RegExp(design.id));
    const doneLine = stream.split("\n\n").find((block) => block.includes("event: done"));
    assert.ok(doneLine);
    const donePayload = JSON.parse(doneLine!.match(/^data: (.+)$/m)![1]) as { response: string };
    assert.doesNotMatch(donePayload.response, /```designs/, "the fenced block never reaches the displayed response");
    assert.match(donePayload.response, /Here are trending sarees/);
    assert.equal(runtime.designs.store.get(design.id)!.shownCount, 1, "a shown design is marked shown");
  });
});

/* ------------------------------------------------------------------ Telegram album ------------------------------------------------------------------ */

test("sendTelegramPhotoAlbum builds a valid multipart body with up to 10 parts and posts to sendMediaGroup", async () => {
  let capturedUrl = "";
  let capturedBody: FormData | undefined;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedBody = init.body as FormData;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  const photos = Array.from({ length: 12 }, (_, i) => ({ id: `dsg_${i}`, bytes: png(i, i, i), mime: "image/png", caption: i === 0 ? "First caption" : undefined }));
  const ok = await sendTelegramPhotoAlbum({ token: "test-token", chatId: "12345", photos }, fakeFetch);
  assert.equal(ok, true);
  assert.match(capturedUrl, /\/bottest-token\/sendMediaGroup$/);
  assert.ok(capturedBody instanceof FormData);
  const media = JSON.parse(String(capturedBody!.get("media"))) as Array<{ type: string; media: string; caption?: string }>;
  assert.equal(media.length, 10, "capped at Telegram's own 10-photo limit");
  assert.equal(media[0].caption, "First caption");
  assert.ok(media.every((entry) => entry.type === "photo" && entry.media.startsWith("attach://")));
  for (let i = 0; i < 10; i++) assert.ok(capturedBody!.get(`file${i}`), `file${i} part is attached`);
  assert.equal(capturedBody!.get("chat_id"), "12345");
});

test("sendTelegramPhotoAlbum resolves false (never throws) on a network failure or an empty photo list", async () => {
  const failing = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
  assert.equal(await sendTelegramPhotoAlbum({ token: "t", chatId: "1", photos: [{ id: "x", bytes: png(), mime: "image/png" }] }, failing), false);
  assert.equal(await sendTelegramPhotoAlbum({ token: "t", chatId: "1", photos: [] }), false);
});
