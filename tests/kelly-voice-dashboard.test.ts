import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HenryRuntime } from "../src/runtime.ts";
import { startDashboard } from "../src/dashboard/server.ts";

function wav(): Buffer {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(36, 4); bytes.write("WAVE", 8); bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24); bytes.writeUInt32LE(32_000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(0, 40);
  return bytes;
}

async function withDashboard(run: (base: string, runtime: HenryRuntime) => Promise<void>): Promise<void> {
  const savedEnv = Object.fromEntries(["KELLY_WHISPER_CPP_PATH", "KELLY_WHISPER_MODEL_PATH", "KELLY_TTS_ENGINE", "KELLY_TTS_EXECUTABLE", "KELLY_TTS_MODEL_PATH", "KELLY_KOKORO_URL", "KELLY_KOKORO_TOKEN"].map(key => [key, process.env[key]]));
  for (const key of Object.keys(savedEnv)) delete process.env[key];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-voice-dashboard-"));
  const runtime = await HenryRuntime.create(tempRoot);
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";
  runtime.config.dashboardToken = "voice-test-owner-token";
  fs.mkdirSync(path.dirname(runtime.config.settingsPath), { recursive: true });
  fs.writeFileSync(runtime.config.settingsPath, JSON.stringify({ "dashboard.auth.localAdminBypass": false }));
  const server = startDashboard(runtime);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try { await run(`http://127.0.0.1:${address.port}`, runtime); }
  finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    runtime.close();
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

test("voice page and APIs use dashboard auth; disabled local engines fail closed", async () => {
  await withDashboard(async (base) => {
    const anonymousPage = await fetch(`${base}/voice`, { headers: { accept: "text/html" }, redirect: "manual" });
    assert.equal(anonymousPage.status, 302);
    assert.equal(anonymousPage.headers.get("location"), "/login");
    const anonymousStatus = await fetch(`${base}/api/voice/status`);
    assert.equal(anonymousStatus.status, 401);

    const auth = { authorization: "Bearer voice-test-owner-token" };
    const page = await fetch(`${base}/voice`, { headers: auth });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Owner workspace\. Review names and quantities before sending\. Shared with your owner chat\./);
    assert.match(html, /Speak reply/);
    assert.match(html, /not an isolated customer thread/);
    assert.match(html, /getUserMedia/);
    assert.match(html, /audio\/wav/);

    const status = await fetch(`${base}/api/voice/status`, { headers: auth }).then(response => response.json()) as { available: boolean; sttEnabled: boolean; ttsEnabled: boolean };
    assert.deepEqual(status, { available: true, sttEnabled: false, ttsEnabled: false });
    const crossOrigin = await fetch(`${base}/api/voice/speak`, { method: "POST", headers: { ...auth, origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ text: "hello" }) });
    assert.equal(crossOrigin.status, 403);
    const audioBody = Uint8Array.from(wav()) as unknown as BodyInit;
    const badMime = await fetch(`${base}/api/voice/transcribe`, { method: "POST", headers: { ...auth, "content-type": "application/octet-stream" }, body: audioBody });
    assert.equal(badMime.status, 415);
    const transcription = await fetch(`${base}/api/voice/transcribe`, { method: "POST", headers: { ...auth, "content-type": "audio/wav" }, body: Uint8Array.from(wav()) as unknown as BodyInit });
    assert.equal(transcription.status, 503, "disabled STT must not call a remote or fallback provider");
    assert.match((await transcription.json() as { error: string }).error, /STT is disabled/);
    const speech = await fetch(`${base}/api/voice/speak`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ text: "namaste", language: "hi" }) });
    assert.equal(speech.status, 503, "disabled TTS must fail closed");
  });
});

test("voice chat routes through the regular conversation but never treats approval words as authorization", async () => {
  await withDashboard(async (base, runtime) => {
    let providerCalls = 0;
    let approvalLookups = 0;
    let approvalExecutions = 0;
    let providerPrompt = "";
    (runtime.agent as unknown as { run: unknown }).run = async (prompt: string) => {
      providerCalls++;
      providerPrompt = prompt;
      return { runId: "voice-chat", provider: "codex", response: "Please confirm the brand and quantity.", exitCode: 0, durationMs: 1, events: [] };
    };
    (runtime.approvals as unknown as { list: unknown }).list = async () => {
      approvalLookups++;
      return [{ id: "pending-post", kind: "social.x-post", title: "Pending post", body: "Draft", payload: {}, status: "pending", createdAt: new Date().toISOString() }];
    };
    (runtime as unknown as { approve: unknown }).approve = async () => { approvalExecutions++; };
    (runtime as unknown as { executeApproval: unknown }).executeApproval = async () => { approvalExecutions++; return "executed"; };

    const response = await fetch(`${base}/api/chat/send`, {
      method: "POST",
      headers: { authorization: "Bearer voice-test-owner-token", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "approve it", voice: true }),
    });
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.match(stream, /Please confirm the brand and quantity/);
    assert.equal(providerCalls, 1, "voice transcript should continue through regular chat SSE");
    assert.equal(approvalLookups, 0, "voice turns skip the explicit approval grammar");
    assert.equal(approvalExecutions, 0, "transcribed approval words must never approve or execute");
    assert.match(providerPrompt, /always answer in clear English/);
    assert.doesNotMatch(providerPrompt, /similar Hindi\/English mix/);
    assert.match(providerPrompt, /Do not guess quantities, units, or brands/);
    assert.match(providerPrompt, /published catalogue and deterministic commerce calculations/);

    const history = await fetch(`${base}/api/chat/history`, { headers: { authorization: "Bearer voice-test-owner-token" } }).then(response => response.json()) as { messages: Array<{ role: string; text: string }> };
    assert.deepEqual(history.messages.map(message => [message.role, message.text]), [
      ["user", "approve it"],
      ["henry", "Please confirm the brand and quantity."],
    ]);
  });
});
