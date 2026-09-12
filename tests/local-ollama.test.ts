import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  configureOllama, ollamaConfig, ollamaNerEnabled, ollamaAvailable, ollamaGenerate, nerNames, resetOllamaCache,
} from "../src/local/ollama.ts";

/**
 * local-ollama.test.ts — the layer-1 client against a REAL http server on port 0 speaking
 * Ollama's two endpoints. A stubbed `fetch` would prove nothing here: every property this
 * module claims (a connect refusal, an abort mid-request, a body that never arrives, a
 * daemon answering something other than JSON) is a socket-level behaviour, and the whole
 * point of the module is that none of them reach the caller as an exception.
 *
 * Settings are pointed at a throwaway file for the whole file so the repo's own
 * data/settings.json can never colour a result.
 */

const SETTINGS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "henry-ollama-"));
const SETTINGS_PATH = path.join(SETTINGS_DIR, "settings.json");
configureOllama({ settingsPath: SETTINGS_PATH });

const DEFAULT_CONFIG = { url: "http://127.0.0.1:11434", model: "llama3.2:3b", timeoutMs: 20000 };

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

interface Fake {
  url: string;
  /** Request count per path, e.g. `hits["/api/tags"]`. */
  hits: Record<string, number>;
  /** Request bodies in arrival order. */
  bodies: string[];
  close(): Promise<void>;
}

/**
 * A fake daemon. Sockets are tracked and destroyed on close because the timeout test leaves
 * a request deliberately unanswered — `server.close()` waits for live connections, so
 * without the destroy the test file would hang instead of failing.
 */
async function startFake(routes: Record<string, Handler>): Promise<Fake> {
  const hits: Record<string, number> = {};
  const bodies: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    req.on("end", () => {
      const route = (req.url ?? "").split("?")[0];
      hits[route] = (hits[route] ?? 0) + 1;
      const body = Buffer.concat(chunks).toString("utf8");
      if (body.length > 0) bodies.push(body);
      const handler = routes[route];
      if (!handler) { res.writeHead(404).end("no such route"); return; }
      handler(req, res, body);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string", "the fake must be listening on a real port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits,
    bodies,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function json(res: http.ServerResponse, payload: unknown): void {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
}

const TAGS_OK: Handler = (_req, res) => json(res, { models: [{ name: "llama3.2:3b", size: 2019393189 }] });

test("ollamaConfig: defaults, then settings local.ollama, then per-call overrides", () => {
  fs.rmSync(SETTINGS_PATH, { force: true });
  assert.deepEqual(ollamaConfig(), DEFAULT_CONFIG, "no settings file at all is the shipping default");
  assert.equal(ollamaNerEnabled(), false, "the local NER pass is opt-in");

  fs.writeFileSync(SETTINGS_PATH, JSON.stringify({
    provider: "claude",
    local: { ollama: { url: "http://127.0.0.1:9999/", model: "qwen2.5:1.5b", timeoutMs: 4321, ner: true } },
  }));
  assert.deepEqual(ollamaConfig(), { url: "http://127.0.0.1:9999", model: "qwen2.5:1.5b", timeoutMs: 4321 },
    "settings win over the defaults and the trailing slash is normalised off");
  assert.equal(ollamaNerEnabled(), true);
  assert.equal(ollamaConfig({ model: "llama3.2:1b" }).model, "llama3.2:1b", "a per-call override wins over settings");
  assert.equal(ollamaConfig({ model: "llama3.2:1b" }).timeoutMs, 4321, "an override of one field leaves the others resolved");

  // Hand-edited settings: a nonsense value must fall back to the default, not break the client.
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ local: { ollama: { url: "", model: 7, timeoutMs: -5, ner: "yes" } } }));
  assert.deepEqual(ollamaConfig(), DEFAULT_CONFIG, "empty/typo'd values are ignored in favour of the defaults");
  assert.equal(ollamaNerEnabled(), false, "ner is strictly === true, not truthy");

  fs.rmSync(SETTINGS_PATH, { force: true });
});

test("ollamaAvailable: one probe per 60s window, and resetOllamaCache() forces a fresh one", async () => {
  const fake = await startFake({ "/api/tags": TAGS_OK });
  const cfg = { url: fake.url, timeoutMs: 2000 };

  assert.equal(await ollamaAvailable(cfg), true);
  assert.equal(await ollamaAvailable(cfg), true);
  assert.equal(await ollamaAvailable(cfg), true);
  assert.equal(fake.hits["/api/tags"], 1, "the 60s cache must serve every repeat probe — one per turn would be a connect per turn");

  resetOllamaCache();
  assert.equal(await ollamaAvailable(cfg), true);
  assert.equal(fake.hits["/api/tags"], 2, "resetOllamaCache() must actually re-probe");

  await fake.close();
});

test("ollamaAvailable: a daemon that answers /api/tags with an error is unavailable, and the verdict is cached too", async () => {
  const fake = await startFake({ "/api/tags": (_req, res) => { res.writeHead(500).end("boom"); } });
  const cfg = { url: fake.url, timeoutMs: 2000 };

  assert.equal(await ollamaAvailable(cfg), false, "a non-2xx is something else on the port, or a broken daemon");
  assert.equal(await ollamaAvailable(cfg), false);
  assert.equal(fake.hits["/api/tags"], 1, "negative verdicts are cached as well — otherwise a down daemon costs a probe per turn");

  await fake.close();
});

test("ollamaGenerate: posts a non-streaming request and returns the response field", async () => {
  const fake = await startFake({
    "/api/generate": (_req, res) => json(res, { model: "llama3.2:3b", response: "The deploy needs a green build.", done: true }),
  });

  const answer = await ollamaGenerate("explain the deploy", { url: fake.url, model: "llama3.2:3b", timeoutMs: 2000 });

  assert.equal(answer, "The deploy needs a green build.");
  assert.deepEqual(JSON.parse(fake.bodies[0]), { model: "llama3.2:3b", prompt: "explain the deploy", stream: false },
    "stream:false is what makes the single-shot JSON body above valid");

  await fake.close();
});

test("ollamaGenerate: every failure mode resolves to null instead of throwing", async () => {
  let mode: "error" | "garbage" | "no-field" | "hang" = "error";
  const fake = await startFake({
    "/api/generate": (_req, res) => {
      if (mode === "error") { res.writeHead(503).end("model is loading"); return; }
      if (mode === "garbage") { res.writeHead(200, { "content-type": "application/json" }).end("<html>not json</html>"); return; }
      if (mode === "no-field") { json(res, { model: "llama3.2:3b", done: true }); return; }
      // "hang": never answer. This is the wedged-daemon case, and the one that would freeze
      // a turn if the abort signal were missing.
    },
  });
  const cfg = { url: fake.url, timeoutMs: 250 };

  assert.equal(await ollamaGenerate("hi", cfg), null, "non-2xx");
  mode = "garbage";
  assert.equal(await ollamaGenerate("hi", cfg), null, "unparseable body");
  mode = "no-field";
  assert.equal(await ollamaGenerate("hi", cfg), null, "a JSON body with no response field");

  mode = "hang";
  const started = Date.now();
  assert.equal(await ollamaGenerate("hi", cfg), null, "a request that is never answered");
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 200 && elapsed < 4000, `the abort must fire near timeoutMs, took ${elapsed}ms`);

  await fake.close();
});

test("nerNames: strict JSON, fenced JSON, junk around the array — and [] whenever it is not sure", async () => {
  let reply = "[]";
  const fake = await startFake({ "/api/generate": (_req, res) => json(res, { response: reply }) });
  const cfg = { url: fake.url, timeoutMs: 2000 };
  const text = "⟨person_1a2b3c4d⟩ asked Tanvi and Mr Sharma about the deployment";

  reply = '["Tanvi","Mr Sharma"]';
  assert.deepEqual(await nerNames(text, cfg), ["Tanvi", "Mr Sharma"], "the happy path: a bare JSON array");

  reply = '```json\n["Tanvi"]\n```';
  assert.deepEqual(await nerNames(text, cfg), ["Tanvi"], "3B models fence their JSON no matter what the prompt says");

  reply = 'Sure! Here are the names I found: ["Tanvi", 7, null, "T", "tanvi", "  Mr Sharma  "] — hope that helps!';
  assert.deepEqual(await nerNames(text, cfg), ["Tanvi", "Mr Sharma"],
    "prose around the array is tolerated; non-strings, single characters and case-duplicates are dropped");

  reply = JSON.stringify({ names: ["Tanvi"] });
  assert.deepEqual(await nerNames(text, cfg), ["Tanvi"], "an object wrapper still yields the array inside it");

  reply = JSON.stringify(Array.from({ length: 40 }, (_v, i) => `Name${i}`));
  assert.equal((await nerNames(text, cfg)).length, 20, "capped at 20 — more than that means the model is rambling, not reading");

  reply = "I could not find any person names in the text.";
  assert.deepEqual(await nerNames(text, cfg), [], "prose with no array at all");

  reply = '["Tanvi", "Mr Sharma"';
  assert.deepEqual(await nerNames(text, cfg), [], "a truncated array is doubt, so nothing is redacted");

  reply = "[Tanvi, Mr Sharma]";
  assert.deepEqual(await nerNames(text, cfg), [], "array-shaped but not JSON");

  reply = JSON.stringify(["There are no person names in this text, only a placeholder token and a subject."]);
  assert.deepEqual(await nerNames(text, cfg), [], "a sentence is not a name — redacting it would eat the question");

  const before = fake.hits["/api/generate"];
  assert.deepEqual(await nerNames("   ", cfg), [], "empty input short-circuits");
  assert.equal(fake.hits["/api/generate"], before, "…without spending a request");

  await fake.close();
});

test("an unreachable daemon: available false and generate null, without waiting out the timeout", async () => {
  // Bind, note the port, then release it: nothing is listening, which is what "Ollama is not
  // installed" looks like from here.
  const dead = await startFake({ "/api/tags": TAGS_OK });
  const url = dead.url;
  await dead.close();
  const cfg = { url, timeoutMs: 20000 };

  const started = Date.now();
  assert.equal(await ollamaAvailable(cfg), false);
  assert.equal(await ollamaGenerate("hi", cfg), null);
  assert.deepEqual(await nerNames("Tanvi asked about the deploy", cfg), []);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 3000, `a refused connection must fail immediately, not after timeoutMs — took ${elapsed}ms`);
});

test("ollamaConfig: a non-loopback url is refused unless local.ollama.allowRemote is true", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "henry-ollama-remote-"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ local: { ollama: { url: "http://10.0.0.5:11434" } } }));
  configureOllama({ settingsPath });
  assert.equal(ollamaConfig().url, "http://127.0.0.1:11434", "a remote url without the opt-in falls back to loopback");

  fs.writeFileSync(settingsPath, JSON.stringify({ local: { ollama: { url: "http://10.0.0.5:11434", allowRemote: true } } }));
  configureOllama({ settingsPath });
  assert.equal(ollamaConfig().url, "http://10.0.0.5:11434", "the explicit opt-in permits a LAN Ollama box");

  fs.writeFileSync(settingsPath, JSON.stringify({ local: { ollama: { url: "http://LOCALHOST:11434/" } } }));
  configureOllama({ settingsPath });
  assert.equal(ollamaConfig().url, "http://LOCALHOST:11434", "loopback in any case passes without the flag");
  configureOllama();
});
