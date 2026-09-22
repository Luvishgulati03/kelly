import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { chromium } from "playwright";
import { encodeSolidPng } from "../src/designs/png.ts";

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const DESIGNS = [
  { id: "dsg_0000000000000001", category: "saree", tags: ["trending"], caption: "Banarasi silk saree", url: "/api/designs/dsg_0000000000000001/image", thumb: "/api/designs/dsg_0000000000000001/thumb" },
  { id: "dsg_0000000000000002", category: "lehenga", tags: ["bridal"], caption: "Bridal lehenga", url: "/api/designs/dsg_0000000000000002/image", thumb: "/api/designs/dsg_0000000000000002/thumb" },
  { id: "dsg_0000000000000003", category: "gown", tags: ["party"], caption: "Evening gown", url: "/api/designs/dsg_0000000000000003/image", thumb: "/api/designs/dsg_0000000000000003/thumb" },
];

test("a designs SSE event renders a gallery strip with one card per design and the lightbox opens on tap", { timeout: 45000 }, async () => {
  const html = await fs.readFile(new URL("../src/dashboard/voice.html", import.meta.url), "utf8");
  const placeholder = encodeSolidPng(80, 100, { r: 200, g: 107, b: 133 });
  const server = http.createServer(async (req, res) => {
    if (req.url === "/voice") { res.setHeader("content-type", "text/html"); res.end(html); return; }
    if (req.url === "/api/voice/status") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ available: true, sttEnabled: false, ttsEnabled: false })); return; }
    if (req.url === "/api/chat/history") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ messages: [] })); return; }
    if (req.url?.startsWith("/api/designs/") && req.url.endsWith("/thumb")) { res.setHeader("content-type", "image/png"); res.end(placeholder); return; }
    if (req.url === "/api/chat/send") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
      res.write(sseEvent("token", { text: "Here are trending sarees.\n" }));
      res.write(sseEvent("designs", { designs: DESIGNS }));
      res.write(sseEvent("done", { response: "Here are trending sarees.", provider: "codex", durationMs: 5, conversationId: "c1" }));
      res.end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://**/*", (route) => route.abort());
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/voice`);

    await page.fill("#transcript", "show me trending sarees");
    await page.getByRole("button", { name: "Send to Kelly", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".gallery-card").length === 3);
    assert.equal(await page.locator(".gallery-card").count(), 3, "one card per shown design");
    assert.equal(await page.locator(".gallery").count(), 1, "exactly one gallery strip for this turn");

    await page.locator(".gallery-card").first().click();
    await page.waitForFunction(() => document.getElementById("lightbox")?.hasAttribute("open"));
    assert.equal((await page.locator("#lbChip").innerText()).toLowerCase(), "saree");
    assert.equal(await page.locator("#lbText").innerText(), "Banarasi silk saree");

    await page.click("#lbNext");
    assert.equal((await page.locator("#lbChip").innerText()).toLowerCase(), "lehenga");
    await page.keyboard.press("ArrowRight");
    assert.equal((await page.locator("#lbChip").innerText()).toLowerCase(), "gown");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("lightbox")?.hasAttribute("open"));

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
