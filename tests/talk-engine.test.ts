import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import { chromium, type Browser, type Page } from "playwright";

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
async function readBuffer(req: http.IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}
function sse(res: http.ServerResponse, ev: string, data: unknown) {
  res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
}
function pathOf(url: string | undefined): string {
  return (url || "").split("?")[0];
}
function assertWav(buf: Buffer, label: string) {
  assert.ok(buf.length > 44, `${label}: has audio payload`);
  assert.equal(buf.subarray(0, 4).toString(), "RIFF", `${label}: RIFF header`);
  assert.equal(buf.readUInt16LE(22), 1, `${label}: mono`);
  assert.equal(buf.readUInt32LE(24), 16000, `${label}: 16 kHz`);
}

/* The fake Silero VAD library. Injected before page scripts via addInitScript so
   `window.vad.MicVAD.new` exists when talk.html's inline script runs `initVad()`.
   Passed as a raw JS source string (not a TS function reference) so esbuild's
   "__name" helper injection never ends up in code that Playwright re-evaluates
   inside the browser, where that helper does not exist. */
const FAKE_VAD_INIT_SRC = `
  (function () {
    var realGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = function (constraints) {
      return realGUM(constraints).then(function (s) {
        window.__pageStream = s;
        window.__pageStreamTrackIds = s.getTracks().map(function (t) { return t.id; });
        return s;
      });
    };

    window.__vadInstances = [];
    window.vad = {
      MicVAD: {
        new: function (opts) {
          var active = false;
          var record = { opts: opts, startCalls: 0, pauseCalls: 0, destroyCalls: 0, setOptionsCalls: [] };
          var fake = {
            start: function () { record.startCalls++; return Promise.resolve(); },
            pause: function () {
              record.pauseCalls++;
              if (opts.submitUserSpeechOnPause && active) {
                active = false;
                return Promise.resolve().then(function () {
                  return opts.onSpeechEnd(new Float32Array(16000));
                });
              }
              return Promise.resolve();
            },
            destroy: function () { record.destroyCalls++; },
            setOptions: function (u) { record.setOptionsCalls.push(u); Object.assign(opts, u); },
          };
          window.__vadInstances.push(record);
          window.__fakeVad = {
            opts: opts, record: record, instance: fake,
            speechStart: function () { active = true; opts.onSpeechStart(); },
            realStart: function () { opts.onSpeechRealStart(); },
            misfire: function () { active = false; opts.onVADMisfire(); },
            speechEnd: function (samples) { active = false; opts.onSpeechEnd(samples || new Float32Array(16000)); },
          };
          return Promise.resolve(fake);
        },
      },
    };
  })();
`;

interface ScenarioStep { delayMs: number; event: string; data: unknown; }

interface ServerState {
  base: string;
  server: http.Server;
  greetingCalls: number;
  repromptCalls: number;
  uploads: Buffer[];
  chatCalls: any[];
  chatRequestTimes: number[];
  speakCalls: any[];
  speakRequestTimes: number[];
  fillerCalls: { v: string | null; at: number }[];
  fillerResponseSentAt: number[];
  conversationsCreated: number;
  chatDoneDelayMs: number;
  /* When set, the default /api/chat/send path sends a `gathering` event with this reason
     as soon as the request arrives (the real server does so for a lookup request). */
  chatGathering: "request" | "tool" | null;
  spokenText: string;
  html: string;
  parentMessagesRoute: boolean;
  /* When set, /api/chat/send plays back this scripted sequence of SSE events instead
     of the single spoken+done pair below. Each step fires delayMs after the request
     is received; a "done" step ends the response. */
  chatScenario: ScenarioStep[] | null;
  /* Normally pending scenario timers are dropped when the client aborts the request
     (mirrors a real network abort). Set true to let them keep firing anyway, which is
     how the interrupt test proves the client-side staleness guard (not the network)
     is what keeps a dropped turn from affecting state. */
  keepScenarioAliveOnAbort: boolean;
  pendingScenarioTimers: NodeJS.Timeout[];
  /* Sample counts of a single /api/voice/speak response, one MediaRecorder-style
     framed chunk per entry. Defaults to the original two 0.1s frames. */
  speakFrameSamplesList: number[];
  /* PNG bytes served at /api/designs/:id/image and /thumb, keyed by design id. */
  designImages: Map<string, Buffer>;
}

async function createServer(html: string): Promise<ServerState> {
  const state: ServerState = {
    base: "", server: null as any,
    greetingCalls: 0, repromptCalls: 0, uploads: [], chatCalls: [], chatRequestTimes: [], speakCalls: [],
    speakRequestTimes: [], fillerCalls: [], fillerResponseSentAt: [],
    conversationsCreated: 0, chatDoneDelayMs: 0, chatGathering: null, spokenText: "Here are some lehenga designs.",
    html, parentMessagesRoute: false,
    chatScenario: null, keepScenarioAliveOnAbort: false, pendingScenarioTimers: [],
    speakFrameSamplesList: [1600, 1600],
    designImages: new Map(),
  };
  const server = http.createServer(async (req, res) => {
    const route = pathOf(req.url);
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (route === "/talk") { res.setHeader("content-type", "text/html"); res.end(state.html); return; }
    if (route === "/parent") {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><html><body>
        <script>window.__parentMessages = [];
        window.addEventListener('message', (e) => { window.__parentMessages.push(e.data); });</script>
        <iframe id="frame" allow="microphone" src="/talk?embed=1&conversationId=conv_owner" style="width:420px;height:640px"></iframe>
      </body></html>`);
      return;
    }
    if (route === "/vendor/vad/bundle.min.js") { res.setHeader("content-type", "text/javascript"); res.end("/* noop */"); return; }
    if (route === "/api/voice/greeting") { state.greetingCalls++; res.setHeader("content-type", "audio/wav"); res.end(tone(800)); return; }
    if (route === "/api/voice/reprompt") { state.repromptCalls++; res.setHeader("content-type", "audio/wav"); res.end(tone(400)); return; }
    if (route === "/api/voice/filler") {
      state.fillerCalls.push({ v: url.searchParams.get("v"), at: Date.now() });
      res.setHeader("content-type", "audio/wav");
      res.end(tone(4800));
      state.fillerResponseSentAt.push(Date.now());
      return;
    }
    if (route === "/api/voice/transcribe") {
      const body = await readBuffer(req);
      state.uploads.push(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ text: "show me lehenga designs", transcriptId: "t1" }));
      return;
    }
    if (route === "/api/conversations") {
      await readJson(req).catch(() => ({}));
      state.conversationsCreated++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ conversation: { id: "conv_" + state.conversationsCreated } }));
      return;
    }
    if (route === "/api/voice/talk/session") {
      await readJson(req).catch(() => ({}));
      res.setHeader("content-type", "application/json"); res.end("{}"); return;
    }
    if (route === "/api/chat/send") {
      const body = await readJson(req);
      state.chatCalls.push(body);
      state.chatRequestTimes.push(Date.now());
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.on("error", () => {}); // a client abort must never crash the fake server
      if (state.chatScenario) {
        const steps = state.chatScenario;
        let ended = false;
        const timers: NodeJS.Timeout[] = [];
        for (const step of steps) {
          const timer = setTimeout(() => {
            if (ended || res.writableEnded || res.destroyed) return;
            try {
              sse(res, step.event, step.data);
              if (step.event === "done") { ended = true; res.end(); }
            } catch { /* the socket may already be gone; that is fine */ }
          }, step.delayMs);
          timers.push(timer);
          state.pendingScenarioTimers.push(timer);
        }
        if (!state.keepScenarioAliveOnAbort) {
          req.on("close", () => timers.forEach(clearTimeout));
        }
        return;
      }
      if (state.chatGathering) sse(res, "gathering", { reason: state.chatGathering });
      const send = () => {
        sse(res, "spoken", { text: state.spokenText });
        sse(res, "done", { response: state.spokenText, spoken: state.spokenText });
        res.end();
      };
      if (state.chatDoneDelayMs > 0) setTimeout(send, state.chatDoneDelayMs); else send();
      return;
    }
    const designImage = route.match(/^\/api\/designs\/([^/]+)\/(image|thumb)$/);
    if (designImage) {
      const png = state.designImages.get(designImage[1]);
      if (!png) { res.writeHead(404).end(); return; }
      res.setHeader("content-type", "image/png"); res.end(png); return;
    }
    if (route === "/api/voice/speak") {
      state.speakRequestTimes.push(Date.now());
      const body = await readJson(req);
      state.speakCalls.push(body);
      res.writeHead(200, { "content-type": "application/x-kelly-wav-seq" });
      for (const samples of state.speakFrameSamplesList) res.write(frame(tone(samples)));
      res.end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  state.server = server;
  state.base = `http://127.0.0.1:${(address as any).port}`;
  return state;
}

async function openTalkPage(browser: Browser, base: string, query = ""): Promise<Page> {
  const page = await browser.newPage();
  await page.route("https://**/*", (route) => route.abort());
  await page.addInitScript({ content: FAKE_VAD_INIT_SRC });
  page.on("pageerror", (error) => { throw new Error(`page error: ${error.message}`); });
  await page.goto(`${base}/talk${query}`);
  await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk");
  return page;
}

async function press(page: Page) {
  await page.getByRole("button", { name: /Tap to talk|End session/, exact: true }).click();
}

async function pressLabeled(page: Page, label: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
}

async function loadHtml(): Promise<string> {
  return fs.readFile(new URL("../src/dashboard/talk.html", import.meta.url), "utf8");
}

async function closeServer(state: ServerState) {
  state.pendingScenarioTimers.forEach(clearTimeout);
  await new Promise<void>((resolve) => state.server.close(() => resolve()));
}

/* Drives one Silero utterance through the fake VAD: onset, real onset, then the audio
   segment ending, exactly as the redemption-window timeout would in the real library. */
async function fireSileroUtterance(page: Page) {
  await page.evaluate(() => (window as any).__fakeVad.speechStart());
  await page.evaluate(() => (window as any).__fakeVad.realStart());
  await page.evaluate(async () => { await Promise.resolve(); (window as any).__fakeVad.speechEnd(new Float32Array(16000)); });
}

/* Starts sampling state/vadRunning every 20ms and recording #audioPlayback "ended"
   timestamps (Date.now(), matching the fake server's clock), until stopSampling() runs. */
async function startSampling(page: Page) {
  await page.evaluate(() => {
    (window as any).__stateSamples = [];
    (window as any).__endedAt = [];
    (window as any).__samplerId = setInterval(() => {
      const kt = (window as any).KellyTalk;
      (window as any).__stateSamples.push({ t: Date.now(), s: kt.state, v: kt.testing.vadRunning });
    }, 20);
    const el = document.getElementById("audioPlayback") as HTMLMediaElement;
    el.addEventListener("ended", () => { (window as any).__endedAt.push(Date.now()); });
  });
}
async function stopSampling(page: Page): Promise<{ samples: { t: number; s: string; v: boolean }[]; endedAt: number[] }> {
  return page.evaluate(() => {
    clearInterval((window as any).__samplerId);
    return { samples: (window as any).__stateSamples, endedAt: (window as any).__endedAt };
  });
}

test("talk engine: Silero wiring, half-duplex, one turn, session-scoped conversations, teardown", { timeout: 120000 }, async () => {
  const html = await loadHtml();
  const state = await createServer(html);
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await openTalkPage(browser, state.base);

    await press(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });

    // --- case 1: Silero wiring ---
    const wiring = await page.evaluate(() => {
      const t = (window as any).KellyTalk.testing;
      const fv = (window as any).__fakeVad;
      return {
        vadMode: t.vadMode,
        startOnLoad: fv.opts.startOnLoad,
        model: fv.opts.model,
        minSpeechMs: fv.opts.minSpeechMs,
        redemptionMs: fv.opts.redemptionMs,
        silenceMs: t.silenceMs,
        submitUserSpeechOnPause: fv.opts.submitUserSpeechOnPause,
      };
    });
    assert.equal(wiring.vadMode, "silero", "silero mode active after greeting");
    assert.equal(wiring.startOnLoad, false, "startOnLoad:false");
    assert.equal(wiring.model, "v5", "model:v5");
    assert.equal(wiring.submitUserSpeechOnPause, true, "submitUserSpeechOnPause:true");
    assert.equal(wiring.redemptionMs, wiring.silenceMs, "redemptionMs equals testing.silenceMs at init");
    assert.ok(typeof wiring.minSpeechMs === "number", "minSpeechMs is set");

    const streamsMatch = await page.evaluate(async () => {
      const fv = (window as any).__fakeVad;
      const s: MediaStream = await fv.opts.getStream();
      const got = s.getTracks().map((t: MediaStreamTrack) => t.id).sort().join(",");
      const want = ((window as any).__pageStreamTrackIds || []).sort().join(",");
      return got === want && got.length > 0;
    });
    assert.equal(streamsMatch, true, "getStream() resolves to the page's own MediaStream (same track ids)");

    await page.evaluate(async () => { await (window as any).__fakeVad.opts.pauseStream(); });
    const micStillActive = await page.evaluate(() => (window as any).KellyTalk.testing.micActive);
    assert.equal(micStillActive, true, "pauseStream() does not stop the tracks");

    // --- case 2 (part 1): vadRunning while Listening ---
    let vadRunning = await page.evaluate(() => (window as any).KellyTalk.testing.vadRunning);
    assert.equal(vadRunning, true, "vadRunning true while Listening");

    // --- case 3: a full Silero turn ---
    await page.evaluate(() => (window as any).__fakeVad.speechStart());
    await page.evaluate(() => (window as any).__fakeVad.realStart());

    // --- case 2 (part 2): vadRunning false while thinking/speaking ---
    await page.evaluate(async () => {
      await Promise.resolve();
      (window as any).__fakeVad.speechEnd(new Float32Array(16000));
    });
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Thinking" || document.querySelector("#state")?.textContent === "Speaking", { timeout: 5000 });
    vadRunning = await page.evaluate(() => (window as any).KellyTalk.testing.vadRunning);
    assert.equal(vadRunning, false, "vadRunning false once the utterance is submitted (half-duplex)");

    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });

    // --- case 2 (part 3): vadRunning true again after auto re-arm ---
    vadRunning = await page.evaluate(() => (window as any).KellyTalk.testing.vadRunning);
    assert.equal(vadRunning, true, "vadRunning true again after the reply finished and the mic re-armed");

    assert.equal(state.uploads.length, 1, "exactly one transcribe upload");
    assertWav(state.uploads[0], "silero turn upload");
    assert.equal(state.chatCalls.length, 1);
    assert.equal(state.chatCalls[0].voice, true, "voice:true");
    assert.equal(state.chatCalls[0].conversationId, "conv_1", "first session's conversation id");
    assert.equal(state.speakCalls.length, 1, "the reply was spoken");

    // --- case 6: ending the session and starting a new one gets a fresh conversation ---
    await pressLabeled(page, "End session");
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk", { timeout: 5000 });

    // --- case 9: teardown releases the mic and destroys the fake VAD ---
    const micAfterEnd = await page.evaluate(() => (window as any).KellyTalk.testing.micActive);
    assert.equal(micAfterEnd, false, "mic released after ending the session");
    await page.waitForFunction(() => {
      const insts = (window as any).__vadInstances || [];
      return insts.length > 0 && insts[insts.length - 1].destroyCalls > 0;
    }, { timeout: 5000 });

    await pressLabeled(page, "Tap to talk");
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
    await page.evaluate(() => (window as any).__fakeVad.speechStart());
    await page.evaluate(() => (window as any).__fakeVad.realStart());
    await page.evaluate(async () => { await Promise.resolve(); (window as any).__fakeVad.speechEnd(new Float32Array(16000)); });
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
    assert.equal(state.chatCalls.length, 2);
    assert.equal(state.chatCalls[1].conversationId, "conv_2", "second session opens a fresh conversation");

    await page.close();
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => state.server.close(() => resolve()));
  }
});

test("talk engine: long-turn window switches to the long redemption mid-utterance", { timeout: 60000 }, async () => {
  const html = await loadHtml();
  const state = await createServer(html);
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await openTalkPage(browser, state.base);
    await page.evaluate(() => { (window as any).KellyTalk.testing.longSilenceAfterMs = 300; });
    await press(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });

    await page.evaluate(() => (window as any).__fakeVad.speechStart());
    await page.waitForTimeout(500);

    const sawLongWindow = await page.evaluate(() => {
      const t = (window as any).KellyTalk.testing;
      const calls = (window as any).__fakeVad.record.setOptionsCalls;
      return calls.some((c: any) => c.redemptionMs === t.longSilenceMs);
    });
    assert.equal(sawLongWindow, true, "setOptions({redemptionMs: testing.longSilenceMs}) was called after longSilenceAfterMs");
    await page.close();
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => state.server.close(() => resolve()));
  }
});

test("talk engine: hard cap submits the speech so far via pause()", { timeout: 60000 }, async () => {
  const html = await loadHtml();
  const state = await createServer(html);
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await openTalkPage(browser, state.base);
    await page.evaluate(() => { (window as any).KellyTalk.testing.hardCapMs = 600; });
    await press(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });

    await page.evaluate(() => (window as any).__fakeVad.speechStart());
    await page.evaluate(() => (window as any).__fakeVad.realStart());

    await page.waitForFunction(() => {
      const fv = (window as any).__fakeVad;
      return fv && fv.record.pauseCalls > 0;
    }, { timeout: 5000 });
    const pauseCalls = await page.evaluate(() => (window as any).__fakeVad.record.pauseCalls);
    assert.ok(pauseCalls > 0, "fake vad pause() was invoked at the hard cap");

    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
    assert.equal(state.uploads.length, 1, "the speech captured before the hard cap was transcribed");
    assertWav(state.uploads[0], "hard-cap upload");
    await page.close();
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => state.server.close(() => resolve()));
  }
});

test("talk engine: holding fillers while the model thinks", { timeout: 60000 }, async () => {
  const html = await loadHtml();
  const state = await createServer(html);
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await openTalkPage(browser, state.base);
    await page.evaluate(() => {
      const t = (window as any).KellyTalk.testing;
      t.fillerMs = 300; t.secondFillerMs = 5000;
    });
    await press(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });

    // --- slow lookup turn: exactly one filler plays, and the reply speak request starts after it ---
    state.chatGathering = "request";
    state.chatDoneDelayMs = 1200;
    await page.evaluate(() => (window as any).__fakeVad.speechStart());
    await page.evaluate(() => (window as any).__fakeVad.realStart());
    await page.evaluate(async () => { await Promise.resolve(); (window as any).__fakeVad.speechEnd(new Float32Array(16000)); });

    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });

    assert.equal(state.fillerCalls.length, 1, "exactly one /api/voice/filler request");
    assert.equal(state.fillerCalls[0].v, "0", "first filler requested with v=0");
    const fillersPlayed = await page.evaluate(() => (window as any).KellyTalk.testing.fillersPlayed);
    assert.equal(fillersPlayed, 1, "testing.fillersPlayed === 1");
    assert.equal(state.speakCalls.length, 1, "the reply was spoken once");
    assert.ok(state.speakRequestTimes[0] >= state.fillerResponseSentAt[0], "speak request started only after the filler audio finished");

    // --- fast turn: chat/send finishes well before fillerMs, no filler requested ---
    state.chatDoneDelayMs = 50;
    await page.evaluate(() => (window as any).__fakeVad.speechStart());
    await page.evaluate(() => (window as any).__fakeVad.realStart());
    await page.evaluate(async () => { await Promise.resolve(); (window as any).__fakeVad.speechEnd(new Float32Array(16000)); });
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
    assert.equal(state.fillerCalls.length, 1, "fast turns never request a filler");

    // --- muted turn: no filler even with a slow chat/send ---
    state.chatDoneDelayMs = 1200;
    await pressLabeled(page, "Mute Kelly's voice");
    await page.evaluate(() => (window as any).__fakeVad.speechStart());
    await page.evaluate(() => (window as any).__fakeVad.realStart());
    await page.evaluate(async () => { await Promise.resolve(); (window as any).__fakeVad.speechEnd(new Float32Array(16000)); });
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
    assert.equal(state.fillerCalls.length, 1, "muted turns never request a filler");
    await page.close();
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => state.server.close(() => resolve()));
  }
});

test("talk engine: embedded session joins the owner's conversation and notifies the parent", { timeout: 60000 }, async () => {
  const html = await loadHtml();
  const state = await createServer(html);
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await browser.newPage();
    await page.route("https://**/*", (route) => route.abort());
    await page.addInitScript({ content: FAKE_VAD_INIT_SRC });
    page.on("pageerror", (error) => { throw new Error(`page error: ${error.message}`); });
    await page.goto(`${state.base}/parent`);

    const frame = page.frames().find((f) => f.url().includes("/talk")) ||
      await page.waitForEvent("frameattached").then(() => page.frames().find((f) => f.url().includes("/talk")));
    assert.ok(frame, "the embedded talk iframe loaded");
    await frame!.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk");

    await frame!.getByRole("button", { name: "Tap to talk", exact: true }).click();
    await frame!.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });

    assert.equal(state.conversationsCreated, 0, "embedded sessions never POST /api/conversations");

    await frame!.evaluate(() => (window as any).__fakeVad.speechStart());
    await frame!.evaluate(() => (window as any).__fakeVad.realStart());
    await frame!.evaluate(async () => { await Promise.resolve(); (window as any).__fakeVad.speechEnd(new Float32Array(16000)); });
    await frame!.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });

    assert.equal(state.chatCalls.length, 1);
    assert.equal(state.chatCalls[0].conversationId, "conv_owner", "the turn carries the owner's conversation id");

    await page.waitForFunction(() => {
      const msgs = (window as any).__parentMessages || [];
      return msgs.some((m: any) => m.type === "kelly-talk" && m.event === "turn" && m.conversationId === "conv_owner");
    }, { timeout: 5000 });

    await frame!.getByRole("button", { name: "End session", exact: true }).click();
    await frame!.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk", { timeout: 5000 });

    await page.waitForFunction(() => {
      const msgs = (window as any).__parentMessages || [];
      return msgs.some((m: any) => m.type === "kelly-talk" && m.event === "ended" && m.conversationId === "conv_owner");
    }, { timeout: 5000 });

    await page.close();
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => state.server.close(() => resolve()));
  }
});

test("talk engine: two spoken lines in one turn play back to back, mic stays muted between them", { timeout: 60000 }, async () => {
  const html = await loadHtml();
  const state = await createServer(html);
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await openTalkPage(browser, state.base);
    await press(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });

    state.speakFrameSamplesList = [4800]; // ~0.3s tone per line
    state.chatScenario = [
      { delayMs: 0, event: "spoken", data: { text: "Checking the rate card." } },
      { delayMs: 400, event: "spoken", data: { text: "Two suits cost 2,205 rupees." } },
      { delayMs: 450, event: "done", data: { response: "", spoken: "" } },
    ];

    await startSampling(page);
    await fireSileroUtterance(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
    const { samples, endedAt } = await stopSampling(page);

    assert.deepEqual(state.speakCalls.map((c) => c.text), [
      "Checking the rate card.",
      "Two suits cost 2,205 rupees.",
    ], "exactly two speak requests, in order");
    assert.equal(state.speakRequestTimes.length, 2);
    assert.equal(endedAt.length, 2, "each line's audio fired one ended event");
    assert.ok(
      state.speakRequestTimes[1] >= endedAt[0],
      `second speak request (${state.speakRequestTimes[1]}) started only after the first line's audio ended (${endedAt[0]})`,
    );

    const lastEnded = endedAt[endedAt.length - 1];
    // Sampling starts while the page is still listening for the utterance; only samples from the
    // moment the turn began (the first non-listening state) can show a premature return.
    const turnStart = samples.findIndex((x) => x.s !== "listening");
    assert.ok(turnStart >= 0, "the turn was sampled");
    const duringTurn = samples.slice(turnStart);
    const prematureListening = duringTurn.filter((x) => x.s === "listening" && x.t < lastEnded - 20);
    assert.deepEqual(prematureListening, [], "state never shows Listening between the two lines");
    const prematureVadRunning = duringTurn.filter((x) => x.v === true && x.t < lastEnded - 20);
    assert.deepEqual(prematureVadRunning, [], "Silero never re-arms (vadRunning) between the two lines");

    assert.equal(await page.evaluate(() => document.querySelector("#state")?.textContent), "Listening", "back to Listening automatically after the second line");
    await page.close();
  } finally {
    await browser.close();
    await closeServer(state);
  }
});

test("talk engine: a line followed by a late done keeps Thinking until done arrives", { timeout: 60000 }, async () => {
  const html = await loadHtml();
  const state = await createServer(html);
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await openTalkPage(browser, state.base);
    await press(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });

    state.speakFrameSamplesList = [4800];
    state.chatScenario = [
      { delayMs: 100, event: "spoken", data: { text: "One moment please." } },
      { delayMs: 1500, event: "done", data: { response: "", spoken: "" } },
    ];

    await fireSileroUtterance(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Thinking", { timeout: 5000 });
    await page.waitForTimeout(800); // well before the 1500ms done, after the ~0.3s line has already finished playing
    assert.equal(await page.evaluate(() => document.querySelector("#state")?.textContent), "Thinking", "still Thinking once the line finished but done has not arrived yet");

    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 5000 });
    assert.equal(state.speakCalls.length, 1, "only the one line was spoken");
    await page.close();
  } finally {
    await browser.close();
    await closeServer(state);
  }
});

test("talk engine: pressing during a line interrupts the turn and a fresh turn works right after", { timeout: 60000 }, async () => {
  const html = await loadHtml();
  const state = await createServer(html);
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await openTalkPage(browser, state.base);
    await press(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });

    state.speakFrameSamplesList = [4800];
    state.keepScenarioAliveOnAbort = true; // proves the client's own staleness guard, not the network, drops the old turn
    state.chatScenario = [
      { delayMs: 0, event: "spoken", data: { text: "Checking the rate card." } },
      { delayMs: 900, event: "spoken", data: { text: "Two suits cost 2,205 rupees." } },
      { delayMs: 950, event: "done", data: { response: "", spoken: "" } },
    ];

    await fireSileroUtterance(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Speaking", { timeout: 5000 });
    await pressLabeled(page, "End session"); // interrupt mid-line
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 5000 });

    const paused = await page.evaluate(() => (document.getElementById("audioPlayback") as HTMLMediaElement).paused);
    assert.equal(paused, true, "playback stopped when interrupted");

    // Wait past the old turn's scheduled second line and done; neither should reach a new speak request.
    await page.waitForTimeout(1300);
    assert.equal(state.speakCalls.length, 1, "no second speak request from the interrupted turn");
    assert.equal(await page.evaluate(() => document.querySelector("#state")?.textContent), "Listening", "the old turn's late done did not move state off Listening");

    // A fresh utterance right after the interrupt completes normally.
    state.chatScenario = null;
    state.keepScenarioAliveOnAbort = false;
    state.speakFrameSamplesList = [1600, 1600];
    await fireSileroUtterance(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
    assert.equal(state.chatCalls.length, 2, "the new turn sent its own chat/send");
    assert.equal(state.speakCalls.length, 2, "the new turn spoke normally");
    await page.close();
  } finally {
    await browser.close();
    await closeServer(state);
  }
});

test("talk engine: muted turn with two spoken lines never calls /api/voice/speak", { timeout: 60000 }, async () => {
  const html = await loadHtml();
  const state = await createServer(html);
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await openTalkPage(browser, state.base);
    await press(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
    await pressLabeled(page, "Mute Kelly's voice");

    state.speakFrameSamplesList = [4800];
    state.chatScenario = [
      { delayMs: 0, event: "spoken", data: { text: "Checking the rate card." } },
      { delayMs: 400, event: "spoken", data: { text: "Two suits cost 2,205 rupees." } },
      { delayMs: 450, event: "done", data: { response: "", spoken: "" } },
    ];

    await fireSileroUtterance(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });

    assert.equal(state.speakCalls.length, 0, "a muted turn never calls /api/voice/speak");
    await page.close();
  } finally {
    await browser.close();
    await closeServer(state);
  }
});

test("talk engine: filler default (1200ms) fires within 1.0-2.5s of the chat/send request on a slow turn", { timeout: 60000 }, async () => {
  const html = await loadHtml();
  const state = await createServer(html);
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await openTalkPage(browser, state.base);
    await press(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });

    // testing.fillerMs is intentionally left untouched (the talk.html default, 1200ms).
    const fillerMs = await page.evaluate(() => (window as any).KellyTalk.testing.fillerMs);
    assert.equal(fillerMs, 1200, "sanity check: the page's default fillerMs is 1200");

    state.chatDoneDelayMs = 3000; // slow turn: long enough for the first filler, short enough to avoid the second
    state.chatGathering = "request"; // the server sends gathering(request) right away for a lookup

    await fireSileroUtterance(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });

    assert.equal(state.fillerCalls.length, 1, "exactly one filler request on this slow turn");
    const gap = state.fillerCalls[0].at - state.chatRequestTimes[0];
    assert.ok(gap >= 1000 && gap <= 2500, `filler requested ${gap}ms after chat/send (expected 1000-2500ms)`);
    await page.close();
  } finally {
    await browser.close();
    await closeServer(state);
  }
});

/* ---------------------------------------------------------------- designs showcase ---------------------------------------------------------------- */

const PNG_CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let c = 0xffffffff; for (const byte of body) c = PNG_CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}
type Rgb = [number, number, number];
/* A portrait "garment" stand-in: a diagonal two-colour gradient with a soft light disc, so a
   crossfade between two of them is visible in a screenshot. */
function gradientPng(width: number, height: number, a: Rgb, b: Rgb): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const t = Math.min(1, Math.max(0, (x / width + y / height) / 2));
      const dx = x - width * .5, dy = y - height * .38;
      const glow = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / (width * .42)) * .45;
      for (let k = 0; k < 3; k++) raw[o++] = Math.round(Math.min(255, (a[k] * (1 - t) + b[k] * t) * (1 - glow) + 255 * glow));
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}
const PALETTE: [Rgb, Rgb][] = [
  [[196, 40, 88], [250, 170, 60]],
  [[30, 110, 200], [60, 210, 180]],
  [[120, 50, 170], [240, 100, 160]],
  [[20, 140, 90], [230, 220, 90]],
  [[200, 90, 30], [110, 30, 60]],
];
function design(n: number, category: string, caption: string) {
  const id = "dsg_" + String(n).padStart(16, "0");
  return { id, category, tags: [], caption, url: `/api/designs/${id}/image`, thumb: `/api/designs/${id}/thumb` };
}
const THREE = [design(1, "lehenga", "Bridal lehenga, zari border"), design(2, "saree", "Banarasi silk saree"), design(3, "suit", "Anarkali suit with dupatta")];
const TWO = [design(4, "gown", "Evening gown, sequin bodice"), design(5, "lehenga", "Pastel lehenga")];
const ONE = [design(1, "lehenga", "Bridal lehenga, zari border")];
function seedImages(state: ServerState) {
  for (let n = 1; n <= 5; n++) state.designImages.set("dsg_" + String(n).padStart(16, "0"), gradientPng(300, 420, ...PALETTE[n - 1]));
}
function designsTurn(designs: unknown[]): ScenarioStep[] {
  return [
    { delayMs: 0, event: "designs", data: { designs } },
    { delayMs: 10, event: "spoken", data: { text: "Here are some designs." } },
    { delayMs: 40, event: "done", data: { response: "", spoken: "" } },
  ];
}
const plainTurn: ScenarioStep[] = [
  { delayMs: 0, event: "spoken", data: { text: "Two suits cost 2,205 rupees." } },
  { delayMs: 40, event: "done", data: { response: "", spoken: "" } },
];
const SHOT_DIR = path.join(os.tmpdir(), "kelly-dash-screenshots");
const LAUNCH_ARGS = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"];
const showcaseOpen = (page: Page) => page.evaluate(() => (window as any).KellyTalk.testing.showcaseOpen as boolean);
const slideIndex = (page: Page) => page.evaluate(() => (window as any).KellyTalk.testing.slideIndex as number);
const stateText = (page: Page) => page.evaluate(() => document.querySelector("#state")?.textContent);

test("talk showcase: designs open a glass slideshow that blends, navigates, and closes without ending the session", { timeout: 120000 }, async () => {
  const html = await loadHtml();
  const state = await createServer(html);
  seedImages(state);
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const errors: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    await page.route("https://**/*", (route) => route.abort());
    await page.addInitScript({ content: FAKE_VAD_INIT_SRC });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${state.base}/talk`);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk");
    assert.equal(await page.locator("#showcase").isHidden(), true, "showcase starts hidden");
    await page.evaluate(() => { (window as any).KellyTalk.testing.slideMs = 300; });
    await press(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });

    // --- a designs turn opens the showcase and docks the orb ---
    state.chatScenario = designsTurn(THREE);
    await fireSileroUtterance(page);
    await page.waitForFunction(() => (window as any).KellyTalk.testing.showcaseOpen, { timeout: 5000 });
    const dialog = page.getByRole("dialog", { name: "Designs" });
    await dialog.waitFor({ state: "visible" });
    assert.equal(await dialog.getAttribute("aria-modal"), "false", "non-modal: the conversation continues");
    assert.equal(await page.locator("#talk").evaluate((el) => el.classList.contains("mini")), true, "the orb container is docked small");
    assert.equal(await page.evaluate(() => document.body.classList.contains("showcase-on")), true);
    assert.equal(await page.locator("#scDots .sc-dot").count(), 3, "one dot per design");
    await page.waitForFunction(() => (window as any).KellyTalk.testing.slideIndex >= 1, { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
    assert.equal(await showcaseOpen(page), true, "still open once the reply finished and the mic re-armed");
    const docked = await page.locator("#talk").boundingBox();
    assert.ok(docked && docked.width > 60 && docked.width < 130, `mini orb is about 96px (got ${docked?.width})`);

    // --- navigation: freeze auto-advance, then prev/next, dots, arrow keys ---
    await page.evaluate(() => { (window as any).KellyTalk.testing.slideMs = 60000; });
    await page.waitForTimeout(800);
    const start = await slideIndex(page);
    await page.getByRole("button", { name: "Next design", exact: true }).click();
    assert.equal(await slideIndex(page), (start + 1) % 3, "next moves forward");
    await page.getByRole("button", { name: "Previous design", exact: true }).click();
    assert.equal(await slideIndex(page), start, "previous moves back");
    await page.locator("#scDots .sc-dot").nth(2).click();
    assert.equal(await slideIndex(page), 2, "a dot jumps to its slide");
    await page.waitForFunction(() => document.querySelectorAll("#scDots .sc-dot")[2].getAttribute("aria-current") === "true");
    await page.locator("body").press("ArrowRight");
    assert.equal(await slideIndex(page), 0, "ArrowRight wraps to the first slide");
    await page.waitForFunction(() => document.querySelector("#scText")?.textContent === "Bridal lehenga, zari border", { timeout: 3000 });
    assert.equal(await page.locator("#scCount").textContent(), "1 / 3");

    // --- a tap on the image opens the lightbox at that slide ---
    await page.mouse.move(0, 0);
    await page.locator("#scStage").click({ position: { x: 200, y: 150 } });
    await page.waitForFunction(() => (document.getElementById("lightbox") as HTMLDialogElement).open, { timeout: 3000 });
    assert.equal(await page.evaluate(() => document.getElementById("lightbox")!.dataset.index), "0", "lightbox opens at the tapped slide");
    await page.locator("#lbClose").click();
    assert.equal(await showcaseOpen(page), true, "closing the lightbox leaves the showcase open");

    // --- Escape closes the showcase, not the session ---
    await page.locator("body").press("Escape");
    await page.waitForFunction(() => !(window as any).KellyTalk.testing.showcaseOpen, { timeout: 3000 });
    await page.waitForFunction(() => document.getElementById("showcase")!.hidden, { timeout: 3000 });
    assert.equal(await stateText(page), "Listening", "session still listening after Escape");
    assert.equal(await page.evaluate(() => (window as any).KellyTalk.testing.micActive), true, "mic still active");
    assert.equal(await page.locator("#talk").getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#talk").evaluate((el) => el.classList.contains("mini")), false, "the orb returns to full size");

    // --- reopen, then a second designs turn replaces the slides in place ---
    state.chatScenario = designsTurn(THREE);
    await fireSileroUtterance(page);
    await page.waitForFunction(() => (window as any).KellyTalk.testing.showcaseOpen, { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
    await page.locator("#scDots .sc-dot").nth(1).click();
    await page.evaluate(() => {
      (window as any).__openSamples = [];
      (window as any).__openSampler = setInterval(() => (window as any).__openSamples.push((window as any).KellyTalk.testing.showcaseOpen), 10);
    });
    state.chatScenario = designsTurn(TWO);
    await page.evaluate(() => (window as any).__fakeVad.speechStart());
    await page.evaluate(() => (window as any).__fakeVad.realStart());
    assert.equal(await showcaseOpen(page), true, "the customer starting to speak does not close the showcase");
    await page.evaluate(async () => { await Promise.resolve(); (window as any).__fakeVad.speechEnd(new Float32Array(16000)); });
    await page.waitForFunction(() => document.querySelectorAll("#scDots .sc-dot").length === 2, { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
    const samples: boolean[] = await page.evaluate(() => { clearInterval((window as any).__openSampler); return (window as any).__openSamples; });
    assert.ok(samples.length > 5 && samples.every(Boolean), "never closed while the slides were replaced");
    assert.equal(await slideIndex(page), 0, "the new set restarts at slide 1");
    await page.waitForFunction(() => document.querySelector("#scText")?.textContent === "Evening gown, sequin bodice", { timeout: 3000 });
    assert.equal(await page.locator("#scCount").textContent(), "1 / 2");

    // --- a following turn whose done arrives without designs closes it ---
    state.chatScenario = plainTurn;
    await fireSileroUtterance(page);
    await page.waitForFunction(() => !(window as any).KellyTalk.testing.showcaseOpen, { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });

    // --- a single design: no dots, no arrows, no auto-advance ---
    await page.evaluate(() => { (window as any).KellyTalk.testing.slideMs = 300; });
    state.chatScenario = designsTurn(ONE);
    await fireSileroUtterance(page);
    await page.waitForFunction(() => (window as any).KellyTalk.testing.showcaseOpen, { timeout: 5000 });
    await page.waitForTimeout(1200);
    assert.equal(await slideIndex(page), 0, "one design never auto-advances");
    assert.equal(await page.locator("#scDots").isVisible(), false, "no dots for one design");
    assert.equal(await page.locator("#scNext").isVisible(), false, "no arrows for one design");
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });

    // --- ending the session closes it ---
    await pressLabeled(page, "End session");
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk", { timeout: 5000 });
    assert.equal(await showcaseOpen(page), false, "teardown closes the showcase");
    await page.waitForFunction(() => document.getElementById("showcase")!.hidden, { timeout: 3000 });
    assert.deepEqual(errors, [], "no page errors");
    await page.close();
  } finally {
    await browser.close();
    await closeServer(state);
  }
});

test("talk showcase: screenshots at phone, tablet and desktop sizes", { timeout: 120000 }, async () => {
  const html = await loadHtml();
  const state = await createServer(html);
  seedImages(state);
  await fs.mkdir(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const errors: string[] = [];
  try {
    const sizes = [
      { name: "phone", width: 400, height: 800 },
      { name: "tablet", width: 768, height: 1024 },
      { name: "desktop", width: 1380, height: 900 },
    ];
    for (const size of sizes) {
      const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
      await page.route("https://**/*", (route) => route.abort());
      await page.addInitScript({ content: FAKE_VAD_INIT_SRC });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${state.base}/talk`);
      await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk");
      await page.evaluate(() => { (window as any).KellyTalk.testing.slideMs = 60000; });
      await press(page);
      await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
      state.chatScenario = designsTurn([...THREE, design(4, "gown", "Evening gown, sequin bodice"), design(5, "lehenga", "Pastel lehenga")]);
      await fireSileroUtterance(page);
      await page.waitForFunction(() => (window as any).KellyTalk.testing.showcaseOpen, { timeout: 5000 });
      await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
      await page.mouse.move(2, 2);
      await page.waitForTimeout(1300);
      await page.screenshot({ path: `${SHOT_DIR}/showcase-${size.name}.png` });
      if (size.name === "tablet") {
        await page.getByRole("button", { name: "Next design", exact: true }).click();
        await page.mouse.move(2, 2);
        await page.waitForTimeout(380);
        await page.screenshot({ path: `${SHOT_DIR}/showcase-tablet-blend.png` });
      }
      await page.close();
    }
    assert.deepEqual(errors, [], "no page errors");
  } finally {
    await browser.close();
    await closeServer(state);
  }
});

test("talk engine: every slow turn asks for filler v=0 first and v=1 second, never a rotating index", { timeout: 60000 }, async () => {
  const html = await loadHtml();
  const state = await createServer(html);
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  try {
    const page = await openTalkPage(browser, state.base);
    await page.evaluate(() => { const t = (window as any).KellyTalk.testing; t.fillerMs = 200; t.secondFillerMs = 800; });
    await press(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });

    // Two lookup turns slow enough for both phrases.
    state.chatGathering = "request";
    state.chatDoneDelayMs = 1600;
    await fireSileroUtterance(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
    assert.deepEqual(state.fillerCalls.map((c) => c.v), ["0", "1"], "first slow turn: v=0 then v=1");
    await fireSileroUtterance(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
    assert.deepEqual(state.fillerCalls.map((c) => c.v), ["0", "1", "0", "1"], "second slow turn starts again at v=0");

    // A turn slow enough only for the first phrase.
    state.chatDoneDelayMs = 500;
    await fireSileroUtterance(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
    assert.deepEqual(state.fillerCalls.map((c) => c.v), ["0", "1", "0", "1", "0"], "a moderately slow turn hears only v=0");
    await page.close();
  } finally {
    await browser.close();
    await closeServer(state);
  }
});

test("talk engine: fillers only follow a gathering event (none for small talk, fillerMs after request, toolFillerMs after tool)", { timeout: 60000 }, async () => {
  const html = await loadHtml();
  const state = await createServer(html);
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  try {
    const page = await openTalkPage(browser, state.base);
    const toolFillerMs = await page.evaluate(() => (window as any).KellyTalk.testing.toolFillerMs);
    assert.equal(toolFillerMs, 300, "sanity check: the page's default toolFillerMs is 300");
    await page.evaluate(() => { const t = (window as any).KellyTalk.testing; t.fillerMs = 400; t.secondFillerMs = 5000; });
    await press(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });

    // Slow small-talk turn: no gathering event, so no filler at all (the orb just shows Thinking).
    state.chatGathering = null;
    state.chatDoneDelayMs = 1500;
    await fireSileroUtterance(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Thinking", { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
    assert.equal(state.fillerCalls.length, 0, "a slow turn without gathering never requests a filler");
    assert.equal(state.speakCalls.length, 1, "the reply itself is still spoken");

    // gathering(request) at t=100ms: filler v=0 fillerMs (400ms) after the event.
    state.chatScenario = [
      { delayMs: 100, event: "gathering", data: { reason: "request" } },
      { delayMs: 1400, event: "spoken", data: { text: "Two suits cost one thousand rupees." } },
      { delayMs: 1450, event: "done", data: { response: "Two suits cost one thousand rupees." } },
    ];
    await fireSileroUtterance(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
    assert.deepEqual(state.fillerCalls.map((c) => c.v), ["0"], "gathering(request) earns filler v=0");
    const requestGap = state.fillerCalls[0].at - state.chatRequestTimes[1];
    assert.ok(requestGap >= 450 && requestGap <= 1200, `filler requested ${requestGap}ms after chat/send (event at 100ms + fillerMs 400ms)`);

    // gathering(tool) at t=100ms: filler v=0 after toolFillerMs (300ms), well before fillerMs would allow.
    await page.evaluate(() => { (window as any).KellyTalk.testing.fillerMs = 3000; (window as any).KellyTalk.testing.secondFillerMs = 9000; });
    state.chatScenario = [
      { delayMs: 100, event: "gathering", data: { reason: "tool" } },
      { delayMs: 1400, event: "spoken", data: { text: "I checked the rate card." } },
      { delayMs: 1450, event: "done", data: { response: "I checked the rate card." } },
    ];
    await fireSileroUtterance(page);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15000 });
    assert.deepEqual(state.fillerCalls.map((c) => c.v), ["0", "0"], "gathering(tool) earns filler v=0 in its own turn");
    const toolGap = state.fillerCalls[1].at - state.chatRequestTimes[2];
    assert.ok(toolGap >= 350 && toolGap <= 1200, `tool filler requested ${toolGap}ms after chat/send (event at 100ms + toolFillerMs 300ms)`);
    await page.close();
  } finally {
    await browser.close();
    await closeServer(state);
  }
});
