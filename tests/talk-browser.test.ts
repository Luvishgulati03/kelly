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
function pathOf(url: string | undefined): string {
  return (url || "").split("?")[0];
}

test("talk page: hands-free orb, greeting, VAD turns, reprompt/sleep, mute, designs, interrupts", { timeout: 120000 }, async () => {
  const html = await fs.readFile(new URL("../src/dashboard/talk.html", import.meta.url), "utf8");
  const TRANSCRIPT = "two lehengas please";
  const SPOKEN = "Two lehengas, noted.";
  const DESIGNS = [
    { category: "lehenga", caption: "Rose gold bridal lehenga", thumb: "/img/a.jpg", url: "/img/a.jpg" },
    { category: "lehenga", caption: "Emerald festive lehenga", thumb: "/img/b.jpg", url: "/img/b.jpg" },
  ];

  const uploads: Buffer[] = [];
  const chatCalls: any[] = [];
  const speakCalls: any[] = [];
  let greetingCalls = 0;
  let repromptCalls = 0;
  let includeDesignsNextTurn = false;

  function makeServer() {
    return http.createServer(async (req, res) => {
      const route = pathOf(req.url);
      if (route === "/talk") { res.setHeader("content-type", "text/html"); res.end(html); return; }
      if (route === "/vendor/vad/bundle.min.js") { res.writeHead(404).end(); return; }
      if (route === "/api/voice/greeting") {
        greetingCalls++;
        res.setHeader("content-type", "audio/wav"); res.end(tone(800)); return;
      }
      if (route === "/api/voice/reprompt") {
        repromptCalls++;
        res.setHeader("content-type", "audio/wav"); res.end(tone(400)); return;
      }
      if (route === "/api/voice/transcribe") {
        const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
        const body = Buffer.concat(parts);
        uploads.push(body);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ text: TRANSCRIPT, transcriptId: "t-" + uploads.length }));
        return;
      }
      if (route === "/api/chat/send") {
        const body = await readJson(req);
        chatCalls.push(body);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        sse(res, "spoken", { text: SPOKEN });
        if (includeDesignsNextTurn) { sse(res, "designs", { designs: DESIGNS }); includeDesignsNextTurn = false; }
        sse(res, "done", { response: SPOKEN, spoken: SPOKEN });
        res.end();
        return;
      }
      if (route === "/api/voice/speak") {
        const body = await readJson(req);
        speakCalls.push(body);
        res.writeHead(200, { "content-type": "application/x-kelly-wav-seq" });
        res.write(frame(tone(1600)));
        res.write(frame(tone(1600)));
        res.end();
        return;
      }
      res.writeHead(404).end();
    });
  }

  const server = makeServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${(address as any).port}`;

  const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  try {
    // --- (1) Rest state: only the orb and status; captions hidden without the query flag ---
    const page = await browser.newPage();
    await page.route("https://**/*", route => route.abort());
    page.on("pageerror", error => errors.push(`${page.url()}: ${error.message}`));
    page.on("console", msg => { if (msg.type() === "error" && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text()); });

    await page.goto(`${base}/talk`);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk");
    assert.equal(await page.locator("#transcript").count(), 0, "no typed transcript panel");
    assert.equal(await page.locator("#send").count(), 0, "no send button");
    assert.equal(await page.locator("#thread").count(), 0, "no chat thread");
    assert.equal(await page.locator("#talk").count(), 1, "only the orb button");
    assert.equal(await page.locator("#talk canvas").count(), 1, "the orb canvas lives inside the talk button");
    assert.equal(await page.locator("#gallery").isHidden(), true, "gallery starts hidden");
    assert.equal(await page.locator("#captions").isHidden(), true, "captions hidden without the query flag");
    assert.equal(await page.evaluate(() => typeof (window as any).KellyOrb?.mount), "function", "orb module is mounted");

    const pageCaptions = await browser.newPage();
    await pageCaptions.route("https://**/*", route => route.abort());
    await pageCaptions.goto(`${base}/talk?captions=1`);
    await pageCaptions.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk");
    assert.equal(await pageCaptions.locator("#captions").isHidden(), false, "captions shown with ?captions=1");
    await pageCaptions.close();

    // --- (2) Press: greeting fetched, then Listening once it ends ---
    await page.getByRole("button", { name: "Tap to talk", exact: true }).click();
    await page.waitForFunction(() => (window as any).KellyTalk?.state === "greeting" || document.querySelector("#state")?.textContent !== "Tap to talk");
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
    assert.equal(greetingCalls, 1, "greeting was requested exactly once");
    assert.equal(await page.locator("#talk").getAttribute("aria-pressed"), "true");

    // --- (3) One VAD turn: exactly one transcribe upload, then chat/send, then chunked speak,
    // then automatic return to Listening with no further press ---
    await page.evaluate(() => {
      const t = (window as any).KellyTalk.testing;
      t.speechMs = 50; t.silenceMs = 5000; t.levelOverride = 0.9;
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => { const t = (window as any).KellyTalk.testing; t.silenceMs = 100; t.levelOverride = 0; });

    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Speaking", { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });

    assert.equal(uploads.length, 1, "exactly one transcribe upload");
    assert.ok(uploads[0].length > 44);
    assert.equal(uploads[0].subarray(0, 4).toString(), "RIFF");
    assert.equal(uploads[0].readUInt16LE(22), 1, "mono");
    assert.equal(uploads[0].readUInt32LE(24), 16000, "16 kHz");
    assert.equal(chatCalls.length, 1);
    assert.equal(chatCalls[0].voice, true, "voice turn is marked voice:true");
    assert.equal(chatCalls[0].prompt, TRANSCRIPT);
    assert.equal(speakCalls.length, 1, "one chunked speak request");
    assert.equal(speakCalls[0].chunk, true);
    assert.equal(await page.locator("#talk").getAttribute("aria-pressed"), "true", "session stays open, no second press needed");

    // --- (4) A second turn happens the same way (proves the mic re-armed) ---
    await page.evaluate(() => {
      const t = (window as any).KellyTalk.testing;
      t.speechMs = 50; t.silenceMs = 5000; t.levelOverride = 0.9;
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => { const t = (window as any).KellyTalk.testing; t.silenceMs = 100; t.levelOverride = 0; });
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Speaking", { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
    assert.equal(uploads.length, 2, "second turn produced a second upload");
    assert.equal(chatCalls.length, 2);
    assert.equal(speakCalls.length, 2);

    // --- (8) designs event renders the strip; it hides again on the next turn ---
    includeDesignsNextTurn = true;
    await page.evaluate(() => {
      const t = (window as any).KellyTalk.testing;
      t.speechMs = 50; t.silenceMs = 5000; t.levelOverride = 0.9;
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => { const t = (window as any).KellyTalk.testing; t.silenceMs = 100; t.levelOverride = 0; });
    await page.waitForFunction(() => document.querySelector("#gallery")?.children.length === 2, { timeout: 15000 });
    assert.equal(await page.locator("#gallery").isHidden(), false, "the design strip is visible once designs arrive");
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });

    // Start a new turn and confirm the strip is cleared as soon as the next utterance begins.
    await page.evaluate(() => {
      const t = (window as any).KellyTalk.testing;
      t.speechMs = 50; t.silenceMs = 5000; t.levelOverride = 0.9;
    });
    await page.waitForFunction(() => document.querySelector("#gallery")?.hasAttribute("hidden"), { timeout: 15000 });
    await page.waitForTimeout(300);
    await page.evaluate(() => { const t = (window as any).KellyTalk.testing; t.silenceMs = 100; t.levelOverride = 0; });
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });

    // --- (6a) Press while speaking stops playback and goes to Listening ---
    await page.evaluate(() => {
      const t = (window as any).KellyTalk.testing;
      t.speechMs = 50; t.silenceMs = 5000; t.levelOverride = 0.9;
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => { const t = (window as any).KellyTalk.testing; t.silenceMs = 100; t.levelOverride = 0; });
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Speaking", { timeout: 15000 });
    await page.getByRole("button", { name: "End session", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 5000 });
    assert.equal(await page.locator("#audioPlayback").evaluate((el: HTMLMediaElement) => el.paused), true, "playback stopped when interrupted");

    // --- (6b) Press while listening ends the session ---
    await page.getByRole("button", { name: "End session", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk", { timeout: 5000 });
    assert.equal(await page.locator("#talk").getAttribute("aria-pressed"), "false");
    assert.equal(await page.evaluate(() => (window as any).KellyTalk.testing.micActive), false, "mic released after manual end");

    // --- (7) Muted: no speak request after done ---
    const speakCountBeforeMute = speakCalls.length;
    await page.getByRole("button", { name: "Mute Kelly's voice", exact: true }).click();
    assert.equal(await page.locator("#mute").getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "Tap to talk", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
    await page.evaluate(() => {
      const t = (window as any).KellyTalk.testing;
      t.speechMs = 50; t.silenceMs = 5000; t.levelOverride = 0.9;
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => { const t = (window as any).KellyTalk.testing; t.silenceMs = 100; t.levelOverride = 0; });
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
    assert.equal(speakCalls.length, speakCountBeforeMute, "muted turns never call /api/voice/speak");
    await page.getByRole("button", { name: "Unmute Kelly's voice", exact: true }).click();

    await page.getByRole("button", { name: "End session", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk", { timeout: 5000 });
    await page.close();

    // --- (5) No speech: reprompt, then idle with the mic released ---
    const page2 = await browser.newPage();
    await page2.route("https://**/*", route => route.abort());
    page2.on("pageerror", error => errors.push(`page2: ${error.message}`));
    page2.on("console", msg => { if (msg.type() === "error" && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text()); });
    const page2Requests: string[] = [];
    page2.on("request", request => page2Requests.push(request.url()));
    await page2.goto(`${base}/talk`);
    await page2.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk");
    await page2.evaluate(() => {
      const t = (window as any).KellyTalk.testing;
      t.repromptMs = 1500; t.sleepMs = 1500; t.levelOverride = 0;
    });
    await page2.getByRole("button", { name: "Tap to talk", exact: true }).click();
    await page2.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
    await page2.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk", { timeout: 15000 });
    assert.ok(page2Requests.some(url => url.includes("/api/voice/reprompt")), "reprompt was requested after repromptMs of silence");
    assert.equal(repromptCalls, 1, "reprompt was requested exactly once");
    assert.equal(await page2.evaluate(() => (window as any).KellyTalk.testing.micActive), false, "mic released once the session sleeps");
    await page2.close();

    assert.deepEqual(errors, [], "no uncaught page errors");
    assert.deepEqual(consoleErrors, [], "no console.error output");
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  // --- Screenshots: idle, listening, speaking at tablet and phone sizes ---
  includeDesignsNextTurn = false;
  const shotServer = makeServer();
  await new Promise<void>(resolve => shotServer.listen(0, "127.0.0.1", resolve));
  const shotAddress = shotServer.address(); assert.ok(shotAddress && typeof shotAddress !== "string");
  const shotBase = `http://127.0.0.1:${(shotAddress as any).port}`;
  const shotBrowser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  try {
    const sizes: Array<[string, number, number]> = [["tablet", 1024, 768], ["phone", 400, 800]];
    for (const [label, width, height] of sizes) {
      const shotPage = await shotBrowser.newPage({ viewport: { width, height } });
      await shotPage.route("https://**/*", route => route.abort());
      await shotPage.goto(`${shotBase}/talk`);
      await shotPage.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk");
      await shotPage.screenshot({ path: `${SCREEN_DIR}/talk-${label}-idle.png` });

      await shotPage.getByRole("button", { name: "Tap to talk", exact: true }).click();
      await shotPage.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
      await shotPage.screenshot({ path: `${SCREEN_DIR}/talk-${label}-listening.png` });

      await shotPage.evaluate(() => {
        const t = (window as any).KellyTalk.testing;
        t.speechMs = 50; t.silenceMs = 5000; t.levelOverride = 0.9;
      });
      await shotPage.waitForTimeout(300);
      await shotPage.evaluate(() => { const t = (window as any).KellyTalk.testing; t.silenceMs = 100; t.levelOverride = 0; });
      await shotPage.waitForFunction(() => document.querySelector("#state")?.textContent === "Speaking", { timeout: 15000 });
      await shotPage.screenshot({ path: `${SCREEN_DIR}/talk-${label}-speaking.png` });

      await shotPage.close();
    }
  } finally {
    await shotBrowser.close();
    await new Promise<void>(resolve => shotServer.close(() => resolve()));
  }
});
