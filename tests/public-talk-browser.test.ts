import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { publicHarness } from "./public-harness.ts";

/**
 * The public Talk and Counter pages end to end in a real browser (the owner's local preview, so
 * the page's own Origin is loopback): greeting, one hands-free turn through /api/public/*, the
 * reply spoken by replyId, and back to listening. The CDN is unreachable here, so the page must
 * also keep working on its energy VAD.
 */

test("public talk page: greeting, one turn through /api/public/*, speech by replyId, back to Listening", { timeout: 120_000 }, async () => {
  const h = await publicHarness();
  h.reply.current = "The 32 amp MCB is 295 rupees including GST. Anything else? Tell me the quantity.";
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  const requests: string[] = [];
  const errors: string[] = [];
  try {
    // The CDN falls back to this server's /vendor/vad/, which really loads Silero (checked below);
    // this first page blocks both so the scripted level drives the energy VAD.
    const page = await browser.newPage();
    await page.route("https://**/*", (route) => route.abort());
    await page.route("**/vendor/vad/**", (route) => route.abort());
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${h.base}/explore/talk`);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk");
    await page.evaluate(() => { const t = (window as any).KellyTalk.testing; t.vadRaceMs = 50; });
    await page.getByRole("button", { name: "Tap to talk", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Listening", { timeout: 15_000 });
    await page.evaluate(() => { const t = (window as any).KellyTalk.testing; t.speechMs = 50; t.silenceMs = 5000; t.levelOverride = 0.9; });
    await page.waitForTimeout(300);
    await page.evaluate(() => { const t = (window as any).KellyTalk.testing; t.silenceMs = 100; t.levelOverride = 0; });
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Speaking", { timeout: 15_000 });
    await page.waitForFunction(() => (window as any).KellyTalk.state === "listening", { timeout: 15_000 });
    assert.equal(h.stt.length, 1, "one transcription");
    assert.equal(h.runs.length, 1, "one public turn");
    assert.ok(h.runs[0].options.publicTurn);
    assert.deepEqual(h.tts.slice(-3), ["The 32 amp MCB is 295 rupees including GST.", "Anything else?", "Tell me the quantity."], "three sentences, synthesised one by one");
    for (const path of requests.filter((value) => value.startsWith("/api/"))) assert.match(path, /^\/api\/public\//, path);
    assert.ok(requests.includes("/api/public/reset"), "a session starts a fresh conversation");
    assert.ok(requests.includes("/api/public/voice/greeting"));
    assert.equal(await page.evaluate(() => (window as any).KellyTalk.testing.vadMode), "energy", "no CDN here: the energy VAD carries the session");
    await page.getByRole("button", { name: "End session", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk", { timeout: 5_000 });

    // With the CDN unreachable, Silero still arrives from this server's /vendor/vad/.
    const fallback = await browser.newPage();
    await fallback.route("https://**/*", (route) => route.abort());
    fallback.on("pageerror", (error) => errors.push(error.message));
    await fallback.goto(`${h.base}/explore/talk`);
    await fallback.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk");
    await fallback.getByRole("button", { name: "Tap to talk", exact: true }).click();
    await fallback.waitForFunction(() => (window as any).KellyTalk.testing.vadSource === "local" && (window as any).KellyTalk.testing.vadMode === "silero", { timeout: 30_000 });
    await fallback.getByRole("button", { name: "End session", exact: true }).click();

    // Counter: a typed turn renders the reply and never asks for speech.
    const counter = await browser.newPage();
    await counter.route("https://**/*", (route) => route.abort());
    counter.on("pageerror", (error) => errors.push(error.message));
    await counter.goto(`${h.base}/explore/counter`);
    await counter.waitForFunction(() => document.querySelector("#state")?.textContent === "Tap to talk");
    await counter.getByRole("button", { name: "Type instead of speaking" }).click();
    h.reply.current = "A 6 amp switch is 53.10 rupees including GST.";
    await counter.fill("#typed", "switch 6A rate?");
    await counter.getByRole("button", { name: "Send", exact: true }).click();
    await counter.waitForFunction(() => /53\.10 rupees/.test(document.querySelector("#reply")?.textContent ?? ""), { timeout: 15_000 });
    assert.equal(h.runs.at(-1)!.prompt.includes("switch 6A rate?"), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await h.close();
  }
});
