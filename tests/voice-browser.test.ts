import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { chromium } from "playwright";

function tone(): Buffer {
  const samples = 24000, wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 16000) * 8000), 44 + i * 2);
  return wav;
}

test("browser microphone capture, discard, keyboard controls and audible media playback", { timeout: 45000 }, async () => {
  const html = await fs.readFile(new URL("../src/dashboard/voice.html", import.meta.url), "utf8");
  const uploads: Buffer[] = [];
  let chatCalls = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/voice") { res.setHeader("content-type", "text/html"); res.end(html); return; }
    if (req.url === "/api/voice/status") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({available:true,sttEnabled:true,ttsEnabled:true})); return; }
    if (req.url === "/api/voice/transcribe") {
      const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
      uploads.push(Buffer.concat(parts));
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({text:"दस बल्ब चाहिए",transcriptId:"test-transcript"})); return;
    }
    if (req.url === "/api/voice/speak") { res.setHeader("content-type", "audio/wav"); res.end(tone()); return; }
    if (req.url === "/api/chat/send") chatCalls++;
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch({headless:true,args:["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream"]});
  try {
    const page = await browser.newPage();
    await page.route("https://**/*", route => route.abort());
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/voice`);
    assert.equal(await page.locator("#language").count(), 0, "language select must be removed");
    assert.equal(await page.getByText("Language", {exact:true}).count(), 0, "no leftover Language label");

    await page.getByRole("button", {name:"Start recording",exact:true}).click();
    await page.waitForFunction(() => /^Recording \d+:\d{2}$/.test(document.querySelector("#state")?.textContent || ""));
    // Wait for real MediaRecorder data rather than a fixed sleep or mocked callbacks.
    await page.waitForFunction(() => /[1-9]\d* bytes captured/.test(document.querySelector("#detail")?.textContent || ""));
    await page.getByRole("button", {name:"Stop recording",exact:true}).click();
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Transcript ready to review");
    assert.equal(uploads.length, 1, "exactly one transcribe upload after one start/stop press cycle");
    assert.ok(uploads[0].length > 44);
    assert.equal(uploads[0].subarray(0,4).toString(), "RIFF");
    assert.equal(uploads[0].readUInt32LE(24), 16000);
    assert.equal(uploads[0].readUInt16LE(22), 1);
    assert.ok(uploads[0].subarray(44).some(byte => byte !== 0), "synthetic microphone audio is not silent");
    assert.equal(chatCalls, 0, "recording never sends an agent message");

    // Enter toggles recording on a focused mic button, just like a click.
    await page.getByRole("button", {name:"Start recording",exact:true}).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /^Recording \d+:\d{2}$/.test(document.querySelector("#state")?.textContent || ""));
    await page.getByRole("button", {name:"Discard recording"}).click();
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Recording discarded");
    assert.equal(uploads.length, 1, "a discarded recording never uploads");

    // Enter also stops recording, toggling back off.
    await page.getByRole("button", {name:"Start recording",exact:true}).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /^Recording \d+:\d{2}$/.test(document.querySelector("#state")?.textContent || ""));
    await page.waitForFunction(() => /[1-9]\d* bytes captured/.test(document.querySelector("#detail")?.textContent || ""));
    await page.getByRole("button", {name:"Stop recording",exact:true}).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Transcript ready to review");
    assert.equal(uploads.length, 2);

    await page.getByRole("button", {name:"Speak transcript",exact:true}).click();
    await page.waitForFunction(() => {
      const audio = document.querySelector("audio");
      return !!audio && !audio.hidden && !!audio.getAttribute("src") && audio.getAttribute("src")!.startsWith("blob:");
    }, {timeout:5000}).catch(async error => {
      console.error(await page.evaluate(() => { const audio=document.querySelector('audio')!; return {message:document.querySelector('#message')?.textContent,src:audio.getAttribute('src'),error:audio.error?.message,readyState:audio.readyState}; }));
      throw error;
    });
    assert.equal(await page.locator("audio").isVisible(), true);
    assert.ok((await page.locator("audio").getAttribute("src"))?.startsWith("blob:"), "speak response blob was assigned to the player");
    await page.getByRole("button", {name:"Stop playback",exact:true}).click();
    assert.equal(await page.locator("audio").isVisible(), false);

    // A rejected autoplay attempt must leave usable native controls and audio intact.
    await page.evaluate(() => { HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException("blocked", "NotAllowedError")); });
    await page.getByRole("button", {name:"Speak transcript",exact:true}).click();
    await page.waitForFunction(() => document.querySelector("#message")?.textContent?.includes("Press Play"));
    assert.equal(await page.locator("audio").isVisible(), true);
    assert.ok(await page.locator("audio").getAttribute("src"));
    assert.deepEqual(errors, []);

    const denied = await browser.newPage();
    await denied.route("https://**/*", route => route.abort());
    await denied.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("denied", "NotAllowedError"); }; });
    await denied.goto(`http://127.0.0.1:${address.port}/voice`);
    await denied.getByRole("button", {name:"Start recording",exact:true}).click();
    await denied.waitForFunction(() => document.querySelector("#detail")?.textContent?.includes("macOS System Settings"));
    assert.equal(await denied.getByRole("button", {name:"Start recording",exact:true}).isEnabled(), true);
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
