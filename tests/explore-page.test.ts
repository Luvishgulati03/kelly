import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { chromium } from "playwright";

const EXPLORE_URL = new URL("../src/dashboard/explore.html", import.meta.url);

/** The only same-origin URLs the public landing page may reference. */
const ALLOWED_PATHS = new Set([
  "/api/public/config",
  "/api/public/heartbeat",
  "/explore/talk",
  "/explore/counter",
  "/explore/chat",
  "/holo.js",
  "/constellation.js",
]);
/** The only external origins: the fonts every Kelly page already loads, and the public repo. */
const ALLOWED_EXTERNAL = [
  /^https:\/\/fonts\.googleapis\.com(\/|$)/,
  /^https:\/\/github\.com\/Luvishgulati03\/kelly$/,
];

const CONFIG = {
  shopName: "Sample Electricals",
  trade: "electrical",
  accent: { copper: "#d08a4b", copper2: "#f0b072", dim: "rgba(208,138,75,.16)" },
  greeting: "Namaste!",
  maxMessageChars: 500,
  voice: { stt: true, tts: true },
  samplePrompts: { talk: ["Show me designs", "मुझे पंखा चाहिए"], counter: [], chat: ["Quote for 5 bulbs"] },
  remoteLogin: false,
};
const HEARTBEAT = {
  online: true, uptimeSeconds: 7384, serverTime: new Date().toISOString(),
  voice: { stt: true, tts: true }, brain: { ready: true, lastReplyMs: 1840 },
  catalogue: { designs: 24 }, visitorsNow: 2,
};

async function readPage(): Promise<string> {
  return fs.readFile(EXPLORE_URL, "utf8");
}

test("explore page: references only the public endpoints, mode links and allowed origins", async () => {
  const html = await readPage();
  const refs = new Set<string>();
  const patterns = [
    /\b(?:href|src|action)\s*=\s*["']([^"']+)["']/g,
    /\bfetch\(\s*["'`]([^"'`]+)["'`]/g,
    /\bgetJson\(\s*["'`]([^"'`]+)["'`]/g,
    /["'`](\/api\/[^"'`\s]*)["'`]/g,
    /["'`](\/(?:explore|voice|talk|counter|chat|memory|login|approve)[^"'`\s]*)["'`]/g,
  ];
  for (const pattern of patterns) for (const match of html.matchAll(pattern)) refs.add(match[1]);
  assert.ok(refs.has("/api/public/config"), "reads the public config");
  assert.ok(refs.has("/api/public/heartbeat"), "polls the public heartbeat");
  for (const ref of refs) {
    if (ref.startsWith("#")) continue;
    if (/^https?:\/\//.test(ref)) {
      assert.ok(ALLOWED_EXTERNAL.some((re) => re.test(ref)), `external reference not allowed: ${ref}`);
      continue;
    }
    assert.ok(ALLOWED_PATHS.has(ref), `same-origin reference not in the public contract: ${ref}`);
  }
  // Belt and braces: none of the private API families appear anywhere in the file.
  assert.doesNotMatch(html, /\/api\/(voice|chat|conversations|activity|events|memory|approvals?|catalogue|designs|usage)\b/);
  assert.doesNotMatch(html, /new\s+(EventSource|WebSocket)\b/);
});

test("explore page: every sample panel is badged and the heartbeat is the only live panel", async () => {
  const html = await readPage();
  const sampleCards = html.match(/<div class="card sampled"[\s\S]*?<\/h3>/g) ?? [];
  assert.equal(sampleCards.length, 3, "conversation, quotation and activity samples");
  for (const card of sampleCards) assert.match(card, /<span class="tag sample">Sample data<\/span>/);
  assert.match(html, /Q-SAMPLE-0042/);
  // An unreplaced server placeholder inside <style> tokenizes as a selector and eats the next rule.
  for (const style of html.match(/<style>[\s\S]*?<\/style>/g) ?? []) assert.doesNotMatch(style, /<!--/);
  assert.match(html, /Sample customer/);
});

test("explore page: invitation pop-up waits 5000 ms and shows once per session behind a guarded sessionStorage", async () => {
  const html = await readPage();
  assert.match(html, /POPUP_DELAY_MS\s*=\s*5000\b/);
  assert.match(html, /setTimeout\(openInvite,\s*POPUP_DELAY_MS\)/);
  assert.match(html, /try\s*\{\s*return window\.sessionStorage\.getItem/);
  assert.match(html, /try\s*\{\s*window\.sessionStorage\.setItem/);
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(html, /prefers-reduced-motion:\s*reduce/);
  assert.match(html, /e\.key === 'Escape'/);
});

test("explore page: carries no personal information", async () => {
  const html = await readPage();
  assert.doesNotMatch(html, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, "no email addresses");
  assert.doesNotMatch(html, /(?:\+91[\s-]?)?\b[6-9]\d{9}\b/, "no Indian mobile numbers");
  assert.doesNotMatch(html, /\/Users\/|\/home\/[a-z]/, "no local machine paths");
  assert.doesNotMatch(html, /\b(trycloudflare|ngrok|\.local\b)/i, "no tunnel or host names");
  assert.doesNotMatch(html.replaceAll("https://github.com/Luvishgulati03/kelly", ""), /luvish|gulati/i,
    "the owner's name appears only inside the public repo URL");
  // Domains: the fonts origin and the repo only.
  const domains = new Set([...html.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase()));
  for (const d of domains) assert.ok(["fonts.googleapis.com", "github.com"].includes(d), `unexpected domain ${d}`);
});

test("explore page: renders at 360px with no horizontal scroll, live vitals, and the 5 s invitation", { timeout: 60000 }, async () => {
  const html = await readPage();
  let heartbeatOk = true;
  let heartbeatHits = 0;
  const server = http.createServer((req, res) => {
    const url = req.url || "";
    if (url === "/" || url === "/explore") { res.setHeader("content-type", "text/html"); res.end(html); return; }
    if (url === "/api/public/config") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(CONFIG)); return; }
    if (url === "/api/public/heartbeat") {
      heartbeatHits += 1;
      if (!heartbeatOk) { res.writeHead(502).end(); return; }
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(HEARTBEAT)); return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 360, height: 780 } });
    const page = await context.newPage();
    await page.route("https://**/*", (route) => route.abort());
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(`${base}/`);
    await page.waitForFunction(() => document.getElementById("shopName")?.textContent === "Sample Electricals");
    await page.waitForFunction(() => document.getElementById("topPill")?.getAttribute("data-state") === "online");
    assert.equal(await page.locator("#vDesigns").textContent(), "24");
    assert.equal(await page.locator("#vVisitors").textContent(), "2");
    assert.equal(await page.locator("#vUptime").textContent(), "2h 3m");
    assert.match((await page.locator("#vLatency").textContent()) ?? "", /^1\.8\s*s$/);
    assert.equal(await page.locator('[data-phrases="talk"] li').count(), 2, "config prompts replace the fallback");
    assert.ok((await page.locator('[data-phrases="counter"] li').count()) > 0, "empty config list falls back to generic prompts");

    const overflow = await page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `horizontal scroll at 360px (${overflow}px)`);
    // overflow-x:hidden would mask a too-wide layout from scrollWidth, so check the boxes too.
    const wide = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll("body *").forEach((n) => {
        const r = n.getBoundingClientRect();
        if (r.width && (r.right > window.innerWidth + 1 || r.left < -1) && !n.closest(".sr-only, .skip")) out.push(`${n.tagName}.${n.className} ${Math.round(r.left)}..${Math.round(r.right)}`);
      });
      return out.slice(0, 5);
    });
    assert.deepEqual(wide, [], "no element extends past the 360px viewport");

    // The invitation: hidden before 5 s, then an aria-modal dialog with focus inside it.
    assert.equal(await page.locator("#invite").isHidden(), true);
    await page.waitForSelector("#invite:not([hidden])", { timeout: 9000 });
    assert.equal(await page.evaluate(() => document.activeElement?.id), "inviteStart");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    assert.ok(await page.evaluate(() => document.querySelector("#invite .sheet")!.contains(document.activeElement)), "focus is trapped");
    await page.keyboard.press("Escape");
    await page.waitForSelector("#invite", { state: "hidden" });

    // Once per session: a reload does not show it again.
    await page.reload();
    await page.waitForTimeout(5600);
    assert.equal(await page.locator("#invite").isHidden(), true, "shown once per browser session");

    // A failing heartbeat puts Kelly to sleep without breaking the page.
    heartbeatOk = false;
    const before = heartbeatHits;
    await page.waitForFunction(() => document.getElementById("topPill")?.getAttribute("data-state") !== "online", undefined, { timeout: 30000 });
    assert.ok(heartbeatHits > before);
    await page.waitForFunction(() => document.body.classList.contains("is-offline"), undefined, { timeout: 30000 });
    assert.equal(await page.locator("#asleep").isVisible(), true);
    const overflowOffline = await page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth);
    assert.ok(overflowOffline <= 1, `horizontal scroll at 360px when offline (${overflowOffline}px)`);

    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
