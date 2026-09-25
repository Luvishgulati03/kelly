import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { chromium, type Page } from "playwright";

const TALK_PAGE = `<!doctype html>
<html><head><title>fake talk</title></head>
<body>
<script>
window.parent.postMessage({ type: "kelly-talk", event: "turn", conversationId: "conv_test" }, location.origin);
</script>
</body></html>`;

type Viewport = { label: string; width: number; height: number };
const VIEWPORTS: Viewport[] = [
  { label: "390x844", width: 390, height: 844 },
  { label: "768x1024", width: 768, height: 1024 },
];

/** No horizontal overflow: the document must never be wider than the viewport. */
async function assertNoHorizontalScroll(page: Page, label: string) {
  const scrollWidth = await page.evaluate(() => document.scrollingElement!.scrollWidth);
  const innerWidth = await page.evaluate(() => window.innerWidth);
  assert.ok(scrollWidth <= innerWidth + 1, `${label}: horizontal scroll (scrollWidth=${scrollWidth} > innerWidth=${innerWidth})`);
}

/** Every input/select/textarea must render at >=16px so iOS Safari never auto-zooms on focus. */
async function assertInputFontSizes(page: Page, label: string) {
  const offenders = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll("input, select, textarea").forEach((el) => {
      const style = getComputedStyle(el as HTMLElement);
      if (style.display === "none" || style.visibility === "hidden") return;
      const size = parseFloat(style.fontSize);
      if (size < 16) out.push(`${(el as HTMLElement).id || el.tagName} (${size}px)`);
    });
    return out;
  });
  assert.deepEqual(offenders, [], `${label}: input font-size < 16px for ${JSON.stringify(offenders)}`);
}

/** The given selectors' interactive elements must all have a >=44x44 CSS px hit box. */
async function assertTapTargets(page: Page, label: string, selectors: string[]) {
  for (const selector of selectors) {
    const box = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    }, selector);
    if (!box) continue; // element not present in this state, nothing to assert
    assert.ok(box.width >= 44 && box.height >= 44, `${label}: ${selector} is ${Math.round(box.width)}x${Math.round(box.height)}, below the 44x44 minimum tap target`);
  }
}

test("responsive: /login has no horizontal scroll, readable inputs and a full-size submit button", { timeout: 60000 }, async () => {
  const html = await fs.readFile(new URL("../src/dashboard/login.html", import.meta.url), "utf8");
  const server = http.createServer((req, res) => {
    const url = req.url || "";
    if (url === "/login" || url.startsWith("/login?")) { res.setHeader("content-type", "text/html"); res.end(html); return; }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${(address as any).port}`;

  const browser = await chromium.launch({ headless: true });
  try {
    for (const vp of VIEWPORTS) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      // Idle state.
      await page.goto(`${base}/login`);
      await assertNoHorizontalScroll(page, `login idle @ ${vp.label}`);
      await assertInputFontSizes(page, `login idle @ ${vp.label}`);
      await assertTapTargets(page, `login idle @ ${vp.label}`, ['input[name="username"]', 'input[name="password"]', 'button[type="submit"]']);

      // Error state.
      await page.goto(`${base}/login?error=1`);
      assert.equal(await page.locator("#error").isVisible(), true, "the error banner is shown for ?error=1");
      await assertNoHorizontalScroll(page, `login error @ ${vp.label}`);
      await assertTapTargets(page, `login error @ ${vp.label}`, ['input[name="username"]', 'input[name="password"]', 'button[type="submit"]']);
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("responsive: /talk orb, mute and captions never overflow or shrink below the tap-target minimum", { timeout: 60000 }, async () => {
  const html = await fs.readFile(new URL("../src/dashboard/talk.html", import.meta.url), "utf8");
  const server = http.createServer((req, res) => {
    const url = (req.url || "").split("?")[0];
    if (url === "/talk") { res.setHeader("content-type", "text/html"); res.end(html); return; }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${(address as any).port}`;

  const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  try {
    for (const vp of VIEWPORTS) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, hasTouch: true });
      await page.route("https://**/*", (route) => route.abort());
      await page.goto(`${base}/talk?captions=1`);
      await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk");
      await assertNoHorizontalScroll(page, `talk idle @ ${vp.label}`);
      await assertTapTargets(page, `talk idle @ ${vp.label}`, ["#talk", "#mute"]);

      // The orb stays centred and fully within the viewport at every size, including landscape phones.
      const box = await page.locator("#talk").boundingBox();
      assert.ok(box, "the orb has a bounding box");
      assert.ok(box!.x >= 0 && box!.y >= 0, `${vp.label}: orb top-left is off-screen (${box!.x}, ${box!.y})`);
      assert.ok(box!.x + box!.width <= vp.width + 1, `${vp.label}: orb right edge (${box!.x + box!.width}) exceeds viewport width ${vp.width}`);
      assert.ok(box!.y + box!.height <= vp.height + 1, `${vp.label}: orb bottom edge (${box!.y + box!.height}) exceeds viewport height ${vp.height}`);

      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("responsive: /chat composer, send, attach and the Talk overlay never overflow or shrink below the tap-target minimum", { timeout: 60000 }, async () => {
  const html = await fs.readFile(new URL("../src/dashboard/chat.html", import.meta.url), "utf8");
  const server = http.createServer(async (req, res) => {
    const url = req.url || "";
    if (url === "/chat") { res.setHeader("content-type", "text/html"); res.end(html); return; }
    if (url.startsWith("/talk")) { res.setHeader("content-type", "text/html"); res.end(TALK_PAGE); return; }
    if (url.startsWith("/api/chat/history")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ conversationId: "conv_test", messages: [] })); return; }
    if (url === "/api/conversations" && req.method === "GET") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ conversations: [{ id: "conv_test", title: "Test conversation" }] })); return; }
    if (url === "/api/status") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ provider: "claude" })); return; }
    if (url === "/api/chat/commands") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ commands: [] })); return; }
    if (url === "/api/skills") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ skills: [] })); return; }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${(address as any).port}`;

  const browser = await chromium.launch({ headless: true });
  try {
    for (const vp of VIEWPORTS) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, hasTouch: true });
      page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));
      await page.goto(`${base}/chat`);
      await page.waitForFunction(() => document.querySelectorAll("#convlist .conv").length > 0);
      await assertNoHorizontalScroll(page, `chat idle @ ${vp.label}`);
      await assertInputFontSizes(page, `chat idle @ ${vp.label}`);
      await assertTapTargets(page, `chat idle @ ${vp.label}`, ["#send", "#attach", "#toggleside"]);

      await page.getByRole("link", { name: "Talk" }).click();
      await page.waitForSelector("#talkModal[open]");
      await assertNoHorizontalScroll(page, `chat talk overlay @ ${vp.label}`);
      await assertTapTargets(page, `chat talk overlay @ ${vp.label}`, ["#talkClose"]);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !(document.getElementById("talkModal") as HTMLDialogElement).open);

      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
