import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { chromium } from "playwright";

const SCREEN_DIR = "/private/tmp/claude-501/-Users-luvishgulati-Downloads-henry/097420ed-722e-42f7-9330-d4ccb33257ef/scratchpad/dash";

function tone(samples: number): Buffer {
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 16000) * 8000), 44 + i * 2);
  return wav;
}
function frame(body: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length, 0);
  return Buffer.concat([len, body]);
}
async function readJson(req: http.IncomingMessage): Promise<any> {
  const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
  const raw = Buffer.concat(parts).toString("utf8"); return raw ? JSON.parse(raw) : {};
}
function sse(res: http.ServerResponse, ev: string, data: unknown) {
  res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
}

test("counter page: conversational capture, typing reply, chunked speech, mute and typed fallback", { timeout: 90000 }, async () => {
  const html = await fs.readFile(new URL("../src/dashboard/counter.html", import.meta.url), "utf8");
  const uploads: Buffer[] = [];
  const chatCalls: any[] = [];
  const speakCalls: any[] = [];
  let counterMode = "conversation";
  const TRANSCRIPT = "ten bulbs please";
  const TOKENS = ["Ten ", "bulbs ", "coming ", "right ", "up."];
  const SPOKEN = "Ten bulbs, got it.";

  const server = http.createServer(async (req, res) => {
    if (req.url === "/counter") { res.setHeader("content-type", "text/html"); res.end(html); return; }
    if (req.url === "/api/voice/status") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ available: true, sttEnabled: true, ttsEnabled: true, counterMode }));
      return;
    }
    if (req.url === "/api/voice/transcribe") {
      const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
      uploads.push(Buffer.concat(parts));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ text: TRANSCRIPT, transcriptId: "t-" + uploads.length }));
      return;
    }
    if (req.url === "/api/chat/send") {
      const body = await readJson(req);
      chatCalls.push(body);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      sse(res, "spoken", { text: SPOKEN });
      for (const t of TOKENS) sse(res, "token", { text: t });
      sse(res, "done", { response: TOKENS.join(""), spoken: SPOKEN });
      res.end();
      return;
    }
    if (req.url === "/api/voice/speak") {
      const body = await readJson(req);
      speakCalls.push(body);
      if (body.chunk) {
        res.writeHead(200, { "content-type": "application/x-kelly-wav-seq" });
        res.write(frame(tone(1600)));
        res.write(frame(tone(1600)));
        res.end();
      } else {
        res.setHeader("content-type", "audio/wav");
        res.end(tone(1600));
      }
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await browser.newPage();
    await page.route("https://**/*", route => route.abort());
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    // Google Fonts is blocked in this offline harness (see the https://**/* route abort below),
    // which itself logs a benign "Failed to load resource" console error; only app-code errors
    // are asserted against.
    const consoleErrors: string[] = []; page.on("console", msg => { if (msg.type() === "error" && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text()); });
    await page.addInitScript(() => {
      (window as any).__srcLog = [];
      document.addEventListener("DOMContentLoaded", () => {
        const el = document.getElementById("audioPlayback") as HTMLMediaElement | null;
        if (!el) return;
        const mo = new MutationObserver(() => { if (el.getAttribute("src")) (window as any).__srcLog.push(el.getAttribute("src")); });
        mo.observe(el, { attributes: true, attributeFilter: ["src"] });
      });
    });

    await page.goto(`${base}/counter`);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk");
    assert.equal(await page.locator("#banner").isVisible(), false, "banner is hidden in conversation mode");
    assert.equal(await page.evaluate(() => typeof (window as any).KellyOrb?.mount), "function", "orb module is mounted");
    assert.equal(await page.locator("#record canvas").count(), 1, "the orb canvas lives inside the talk button");
    assert.equal(await page.locator("#audioPlayback").count(), 1);

    // --- Tap to talk, auto-stop with no second tap ---
    await page.evaluate(() => {
      const t = (window as any).KellyCounter.testing;
      t.speechMs = 50; t.silenceMs = 5000; // silence window widened until we choose to end it
      t.levelOverride = 0.9;
    });
    await page.getByRole("button", { name: "Start talking", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening…");
    assert.equal(await page.locator("#record").getAttribute("aria-pressed"), "true");
    await page.waitForTimeout(400); // let speech-detected latch and at least one MediaRecorder chunk arrive
    await page.evaluate(() => {
      const t = (window as any).KellyCounter.testing;
      t.silenceMs = 80;
      t.levelOverride = 0; // simulate silence; the fake microphone itself never falls quiet
    });

    await page.waitForFunction(() => (document.querySelector("#heard")?.textContent || "").length > 0, { timeout: 15000 });
    assert.equal(await page.locator("#record").getAttribute("aria-pressed"), "false", "recording auto-stopped without a second tap");
    assert.equal(uploads.length, 1, "exactly one transcribe upload");
    assert.ok(uploads[0].length > 44);
    assert.equal(uploads[0].subarray(0, 4).toString(), "RIFF");
    assert.equal(uploads[0].readUInt16LE(22), 1, "mono");
    assert.equal(uploads[0].readUInt32LE(24), 16000, "16 kHz");
    assert.equal(await page.locator("#heard").textContent(), TRANSCRIPT);

    await page.waitForFunction((full) => document.querySelector("#reply")?.textContent === full, TOKENS.join(""), { timeout: 15000 });
    assert.equal(chatCalls.length, 1);
    assert.equal(chatCalls[0].voice, true, "voice-originated turn is marked voice:true");
    assert.equal(chatCalls[0].prompt, TRANSCRIPT);

    assert.equal(speakCalls.length, 1, "the spoken preview triggered exactly one speech request");
    assert.equal(speakCalls[0].chunk, true, "speech was requested in chunked mode");

    await page.waitForFunction(() => (window as any).__srcLog.length >= 2, { timeout: 15000 });
    const srcLog: string[] = await page.evaluate(() => (window as any).__srcLog);
    assert.ok(srcLog.length >= 2, "two frames were assigned to the player in order");
    assert.notEqual(srcLog[0], srcLog[1], "each frame got its own blob URL");
    assert.ok(srcLog.every(s => s.startsWith("blob:")));

    await page.waitForFunction(() => document.querySelector("#stop")?.hasAttribute("hidden"), { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk", { timeout: 5000 });

    // --- Mute prevents a speak request on the next voiced turn ---
    await page.getByRole("button", { name: "Mute Kelly's voice", exact: true }).click();
    assert.equal(await page.locator("#mute").getAttribute("aria-pressed"), "true");

    await page.evaluate(() => {
      const t = (window as any).KellyCounter.testing;
      t.speechMs = 50; t.silenceMs = 5000; t.levelOverride = 0.9;
    });
    await page.getByRole("button", { name: "Start talking", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening…");
    await page.waitForTimeout(400);
    await page.evaluate(() => { const t = (window as any).KellyCounter.testing; t.silenceMs = 80; t.levelOverride = 0; });
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk", { timeout: 15000 });
    assert.equal(uploads.length, 2, "a second recording round produced a second upload");
    assert.equal(chatCalls.length, 2, "the second voiced turn also reached the chat endpoint");
    assert.equal(speakCalls.length, 1, "muted turns never call /api/voice/speak");

    // --- Unmute, then confirm the typed fallback never auto-speaks ---
    await page.getByRole("button", { name: "Unmute Kelly's voice", exact: true }).click();
    assert.equal(await page.locator("#mute").getAttribute("aria-pressed"), "false");
    await page.getByRole("button", { name: "Type instead of speaking", exact: true }).click();
    await page.fill("#typed", "do you have blue thread");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForFunction((full) => document.querySelector("#reply")?.textContent === full, TOKENS.join(""), { timeout: 15000 });
    assert.equal(chatCalls.length, 3, "typed fallback also reached the chat endpoint");
    assert.equal(chatCalls[2].voice, false, "typed turns are sent as voice:false");
    assert.equal(chatCalls[2].prompt, "do you have blue thread");
    assert.equal(speakCalls.length, 1, "the typed fallback never triggers a speak request, muted or not");

    assert.deepEqual(errors, [], "no uncaught page errors");
    assert.deepEqual(consoleErrors, [], "no console.error output");

    // --- Banner appears when the page is in preview (not conversation mode) ---
    counterMode = "review";
    const page2 = await browser.newPage();
    await page2.route("https://**/*", route => route.abort());
    await page2.goto(`${base}/counter`);
    await page2.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk");
    assert.equal(await page2.locator("#banner").isVisible(), true, "banner shows when counter mode is not conversation");
    const bannerText = (await page2.locator("#banner").textContent()) || "";
    assert.ok(bannerText.includes("preview"));
    assert.ok(!bannerText.includes("—"), "no em dash in visible strings");
    assert.equal(await page2.getByRole("button", { name: "Start talking", exact: true }).isEnabled(), true, "the page stays fully functional in preview");
    await page2.close();
    counterMode = "conversation";

    await page.close();
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  // --- Screenshots ---
  await fs.mkdir(SCREEN_DIR, { recursive: true });
  const shotServer = http.createServer(async (req, res) => {
    if (req.url === "/counter") { res.setHeader("content-type", "text/html"); res.end(html); return; }
    if (req.url === "/api/voice/status") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ available: true, sttEnabled: true, ttsEnabled: true, counterMode: "conversation" }));
      return;
    }
    if (req.url === "/api/voice/transcribe") {
      const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ text: TRANSCRIPT, transcriptId: "shot" }));
      return;
    }
    if (req.url === "/api/chat/send") {
      await readJson(req);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      sse(res, "spoken", { text: SPOKEN });
      for (const t of TOKENS) sse(res, "token", { text: t });
      sse(res, "done", { response: TOKENS.join(""), spoken: SPOKEN });
      res.end();
      return;
    }
    if (req.url === "/api/voice/speak") {
      const body = await readJson(req);
      res.writeHead(200, { "content-type": "application/x-kelly-wav-seq" });
      res.write(frame(tone(1600))); res.write(frame(tone(1600))); res.end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => shotServer.listen(0, "127.0.0.1", resolve));
  const shotAddress = shotServer.address(); assert.ok(shotAddress && typeof shotAddress !== "string");
  const shotBase = `http://127.0.0.1:${(shotAddress as any).port}`;
  const shotBrowser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  try {
    const sizes: Array<[string, number, number]> = [["tablet", 1024, 768], ["phone", 400, 800]];
    for (const [label, width, height] of sizes) {
      const shotPage = await shotBrowser.newPage({ viewport: { width, height } });
      await shotPage.route("https://**/*", route => route.abort());
      await shotPage.goto(`${shotBase}/counter`);
      await shotPage.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk");
      await shotPage.screenshot({ path: `${SCREEN_DIR}/conv-${label}-idle.png` });

      await shotPage.evaluate(() => {
        const t = (window as any).KellyCounter.testing;
        t.speechMs = 50; t.silenceMs = 5000; t.levelOverride = 0.9;
      });
      await shotPage.getByRole("button", { name: "Start talking", exact: true }).click();
      await shotPage.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening…");
      await shotPage.screenshot({ path: `${SCREEN_DIR}/conv-${label}-listening.png` });

      await shotPage.waitForTimeout(400);
      await shotPage.evaluate(() => { const t = (window as any).KellyCounter.testing; t.silenceMs = 80; t.levelOverride = 0; });
      await shotPage.waitForFunction((full) => document.querySelector("#reply")?.textContent === full, TOKENS.join(""), { timeout: 15000 });
      await shotPage.screenshot({ path: `${SCREEN_DIR}/conv-${label}-reply.png` });
      await shotPage.close();
    }
  } finally {
    await shotBrowser.close();
    await new Promise<void>(resolve => shotServer.close(() => resolve()));
  }
});
