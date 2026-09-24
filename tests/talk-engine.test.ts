import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
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
}

async function createServer(html: string): Promise<ServerState> {
  const state: ServerState = {
    base: "", server: null as any,
    greetingCalls: 0, repromptCalls: 0, uploads: [], chatCalls: [], chatRequestTimes: [], speakCalls: [],
    speakRequestTimes: [], fillerCalls: [], fillerResponseSentAt: [],
    conversationsCreated: 0, chatDoneDelayMs: 0, spokenText: "Here are some lehenga designs.",
    html, parentMessagesRoute: false,
    chatScenario: null, keepScenarioAliveOnAbort: false, pendingScenarioTimers: [],
    speakFrameSamplesList: [1600, 1600],
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
      const send = () => {
        sse(res, "spoken", { text: state.spokenText });
        sse(res, "done", { response: state.spokenText, spoken: state.spokenText });
        res.end();
      };
      if (state.chatDoneDelayMs > 0) setTimeout(send, state.chatDoneDelayMs); else send();
      return;
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

    // --- slow turn: exactly one filler plays, and the reply speak request starts after it ---
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
    const prematureListening = samples.filter((x) => x.s === "listening" && x.t < lastEnded - 20);
    assert.deepEqual(prematureListening, [], "state never shows Listening between the two lines");
    const prematureVadRunning = samples.filter((x) => x.v === true && x.t < lastEnded - 20);
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
