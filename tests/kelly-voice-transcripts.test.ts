import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { setActiveProfile } from "../src/profile.ts";
import { HenryRuntime } from "../src/runtime.ts";
import { startDashboard } from "../src/dashboard/server.ts";
import {
  VOICE_SETTINGS_DEFAULTS, VoiceTranscriptStore, extractEntities, readVoiceSettings, updateVoiceSettings,
} from "../src/voice/transcripts.ts";
import { summarizeUsage } from "../src/dashboard/usage.ts";
import { providerUsage } from "../src/providers/runner.ts";
import type { ActivityEvent } from "../src/types.ts";

/**
 * THE TRANSCRIPT STORE AND THE USAGE VIEW.
 *
 * Two owner promises are pinned here: words are kept only for the retention window the
 * owner set, and a recording exists on disk only while recording is switched ON. The usage
 * numbers are the CLIs' own token counts and Kelly's own timings, never estimates.
 */

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function storeIn(root: string): { store: VoiceTranscriptStore; settingsPath: string; dataDir: string } {
  const dataDir = path.join(root, "data");
  const settingsPath = path.join(dataDir, "settings.json");
  fs.mkdirSync(dataDir, { recursive: true });
  return { store: new VoiceTranscriptStore(dataDir, settingsPath), settingsPath, dataDir };
}

/* ------------------------------------------------------------------ *
 * 1. Settings: 60 days of text, recording off, both owner-changeable
 * ------------------------------------------------------------------ */

test("voice settings default to 60 days of text and no recording", () => {
  const root = tempDir("kelly-vs-");
  const settingsPath = path.join(root, "settings.json");
  assert.deepEqual(readVoiceSettings(settingsPath), { retentionDays: 60, recordAudio: false, audioRetentionDays: 7, counterMode: "review" });
  assert.deepEqual(readVoiceSettings(settingsPath), VOICE_SETTINGS_DEFAULTS);

  const updated = updateVoiceSettings(settingsPath, { recordAudio: true, retentionDays: 90 });
  assert.deepEqual(updated, { retentionDays: 90, recordAudio: true, audioRetentionDays: 7, counterMode: "review" });
  assert.deepEqual(readVoiceSettings(settingsPath), updated, "persisted through settings.json");

  const clamped = updateVoiceSettings(settingsPath, { retentionDays: 9999, audioRetentionDays: 0 });
  assert.equal(clamped.retentionDays, 365, "retention is clamped to a year");
  assert.equal(clamped.audioRetentionDays, 1, "and audio retention to at least a day");
  const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { voice: unknown };
  assert.ok(raw.voice, "settings live under the voice key beside every other setting");
});

/* ------------------------------------------------------------------ *
 * 2. Entities: what a quotation depends on, display only
 * ------------------------------------------------------------------ */

test("entity extraction sees brands, quantities and units in Hindi, English and Hinglish", () => {
  const hindi = extractEntities("हैवेल्स के दो सीलिंग फैन का कोटेशन बना दो");
  assert.deepEqual(hindi.brands, ["Havells"]);
  assert.equal(hindi.sparse, false, "a brand alone is enough to not be sparse");

  const wire = extractEntities("Polycab ka 1.5 sq mm wire, 100 m coil ka rate");
  assert.deepEqual(wire.brands, ["Polycab"]);
  assert.ok(wire.units.includes("sq mm"), `units: ${wire.units.join(",")}`);
  assert.ok(wire.units.includes("m"));
  assert.ok(wire.quantities.some((q) => /1\.5\s*sq mm/i.test(q)), `quantities: ${wire.quantities.join(" | ")}`);

  const mcb = extractEntities("Quote me twelve 32 amp MCB from Legrand");
  assert.deepEqual(mcb.brands, ["Legrand"]);
  assert.ok(mcb.units.includes("A"));

  const vague = extractEntities("वो वाली लाइट भेज दो");
  assert.equal(vague.sparse, true, "no brand and no quantity means Kelly should ask");
  assert.deepEqual(vague.brands, []);

  const noise = extractEntities("Send the approved list to the vendor by evening");
  assert.deepEqual(noise.brands, [], "ordinary words are not brands");
});

/* ------------------------------------------------------------------ *
 * 3. The store: record, settle, filter, prune, and audio only when on
 * ------------------------------------------------------------------ */

test("transcripts are recorded, settled through their states, and searchable", () => {
  const { store } = storeIn(tempDir("kelly-ts-"));
  const a = store.record({ surface: "telegram", text: "Polycab ka 1.5 sq mm wire ka rate", language: "hi", durationSeconds: 9, bytes: 142_000, sttMs: 6_800 });
  assert.equal(a.state, "transcribed");
  assert.deepEqual(a.entities.brands, ["Polycab"]);

  const confirmed = store.update(a.id, { state: "confirmed" });
  assert.equal(confirmed?.state, "confirmed");
  const answered = store.update(a.id, { state: "answered", reply: "Polycab 1.5 sq mm: ₹1,240 per 90 m coil." });
  assert.equal(answered?.state, "answered");
  assert.match(answered?.reply ?? "", /1,240/);
  assert.ok(answered?.replyAt);

  const b = store.record({ surface: "counter", text: "वो वाली लाइट चार पीस भेज दो", language: "hi", durationSeconds: 4 });
  const failed = store.record({ surface: "telegram", text: "", state: "failed", error: "could not convert audio" });
  assert.equal(failed.state, "failed");

  assert.equal(store.list().length, 3);
  assert.deepEqual(store.list({ surface: "counter" }).map((r) => r.id), [b.id]);
  assert.deepEqual(store.list({ state: "answered" }).map((r) => r.id), [a.id]);
  assert.deepEqual(store.list({ q: "polycab" }).map((r) => r.id), [a.id], "search is case-insensitive over the words");
  assert.deepEqual(store.list({ q: "1,240" }).map((r) => r.id), [a.id], "and over the reply");
  assert.deepEqual(store.list({ sparse: true }).map((r) => r.id), [b.id, failed.id].filter((id) => store.get(id)?.entities.sparse));

  const stats = store.stats();
  assert.equal(stats.total, 3);
  assert.equal(stats.today, 3);
  assert.deepEqual(stats.bySurface, { counter: 1, telegram: 2 });
  assert.equal(stats.unconfirmed, 1, "the counter note is still waiting");
  assert.equal(stats.failed, 1);
  assert.equal(stats.audioKept, 0);
  store.close();
});

test("audio is written only while recording is on, and vanishes when it is switched off", () => {
  const { store, settingsPath } = storeIn(tempDir("kelly-ta-"));
  const wav = Buffer.from("RIFFfakeWAVE");
  const off = store.record({ surface: "counter", text: "ek 20W batten ka rate" });
  assert.equal(store.saveAudio(off.id, wav), undefined, "recording is off by default: nothing is written");
  assert.equal(store.audioPath(off.id), undefined);

  updateVoiceSettings(settingsPath, { recordAudio: true });
  const on = store.record({ surface: "counter", text: "do fan ka quote" });
  const kept = store.saveAudio(on.id, wav);
  assert.ok(kept && fs.existsSync(kept), "with recording on, the clip is on disk");
  assert.equal((fs.statSync(kept).mode & 0o777), 0o600, "and private to the owner");
  assert.equal(store.audioPath(on.id), kept);
  assert.equal(store.stats().audioKept, 1);

  assert.equal(store.discardAllAudio(), 1, "switching recording off removes every kept clip");
  assert.equal(fs.existsSync(kept), false);
  assert.equal(store.audioPath(on.id), undefined);
  assert.equal(store.get(on.id)?.text, "do fan ka quote", "the words outlive the recording");
  store.close();
});

/* ------------------------------------------------------------------ *
 * 3b. Legacy Roman text, hidden original script, and the `mixed` flag
 * ------------------------------------------------------------------ */

test("legacy original is kept only when it differs from Roman text, and mixed reflects that", () => {
  const { store } = storeIn(tempDir("kelly-to-"));

  // Whisper wrote Devanagari; the caller (server/runtime) converts and passes both.
  const converted = store.record({ surface: "counter", text: "Havells ke do ceiling fan ka quotation bana do", original: "हैवेल्स के दो सीलिंग फैन का कोटेशन बना दो" });
  assert.equal(converted.mixed, true);
  assert.equal(converted.original, "हैवेल्स के दो सीलिंग फैन का कोटेशन बना दो");
  assert.equal(store.get(converted.id)?.original, "हैवेल्स के दो सीलिंग फैन का कोटेशन बना दो");
  assert.equal(store.get(converted.id)?.mixed, true);

  // Pure English: caller may pass the same string as both text and original (or omit it);
  // either way nothing extra is stored.
  const plain = store.record({ surface: "counter", text: "20 watt bulb please", original: "20 watt bulb please" });
  assert.equal(plain.mixed, false);
  assert.equal(plain.original, undefined);
  assert.equal(store.get(plain.id)?.original, undefined);

  const noOriginal = store.record({ surface: "counter", text: "20 watt bulb please" });
  assert.equal(noOriginal.mixed, false);
  assert.equal(noOriginal.original, undefined);

  store.close();
});

test("legacy entity extraction unions brands from Roman text and the hidden original", () => {
  const { store } = storeIn(tempDir("kelly-toe-"));
  // A brand the Roman pass missed (simulated: Roman text drops the brand, original keeps it).
  const row = store.record({ surface: "telegram", text: "ka do fan ka quotation bana do", original: "हैवेल्स का दो fan ka quotation bana do" });
  assert.ok(row.entities.brands.includes("Havells"), `brands: ${row.entities.brands.join(",")}`);
  store.close();
});

test("counter transcript principal survives storage without changing legacy records", () => {
  const { store } = storeIn(tempDir("kelly-principal-"));
  const scoped = store.record({ surface: "counter", text: "do fan", principal: "opaque-principal" });
  assert.equal(store.get(scoped.id)?.principal, "opaque-principal");
  const legacy = store.record({ surface: "telegram", text: "do fan" });
  assert.equal(store.get(legacy.id)?.principal, undefined);
  store.close();
});

test("legacy search matches the hidden original script as well as Roman text", () => {
  const { store } = storeIn(tempDir("kelly-tos-"));
  const row = store.record({ surface: "counter", text: "Havells ke do fan", original: "हैवेल्स के दो fan" });
  assert.deepEqual(store.list({ q: "havells" }).map((r) => r.id), [row.id], "matches the Roman text");
  assert.deepEqual(store.list({ q: "हैवेल्स" }).map((r) => r.id), [row.id], "matches the hidden original script");
  assert.deepEqual(store.list({ q: "nonsense" }).map((r) => r.id), []);
  store.close();
});

test("a database created before the original column existed is migrated in place", () => {
  const root = tempDir("kelly-tmig-");
  const dataDir = path.join(root, "data");
  const settingsPath = path.join(dataDir, "settings.json");
  fs.mkdirSync(path.join(dataDir, "voice", "audio"), { recursive: true });
  const dbPath = path.join(dataDir, "voice", "transcripts.db");

  // Hand-build the pre-migration schema (no `original` column) and seed one row.
  const legacy = new Database(dbPath);
  legacy.exec(`CREATE TABLE transcripts (
    id TEXT PRIMARY KEY, at TEXT NOT NULL, surface TEXT NOT NULL, language TEXT,
    durationSeconds REAL, bytes INTEGER, sttMs INTEGER, text TEXT NOT NULL, entities TEXT NOT NULL,
    state TEXT NOT NULL, conversationId TEXT, reply TEXT, replyAt TEXT, audioPath TEXT, error TEXT
  )`);
  legacy.prepare(`INSERT INTO transcripts (id, at, surface, language, durationSeconds, bytes, sttMs, text, entities, state, conversationId, reply, replyAt, audioPath, error)
    VALUES ('legacy-1', '2026-01-01T00:00:00.000Z', 'counter', NULL, NULL, NULL, NULL, 'old row', '{"brands":[],"quantities":[],"units":[],"sparse":true}', 'transcribed', NULL, NULL, NULL, NULL, NULL)`).run();
  legacy.close();

  const store = new VoiceTranscriptStore(dataDir, settingsPath);
  const inspector = new Database(dbPath);
  const columns = inspector.prepare("PRAGMA table_info(transcripts)").all() as Array<{ name: string }>;
  inspector.close();
  assert.ok(columns.some((c) => c.name === "original"), "the column is added to the existing database");

  const migrated = store.get("legacy-1");
  assert.equal(migrated?.text, "old row", "the pre-existing row survives the migration");
  assert.equal(migrated?.original, undefined);
  assert.equal(migrated?.mixed, false);

  const fresh = store.record({ surface: "counter", text: "Havells ka bulb", original: "हैवेल्स का bulb" });
  assert.equal(fresh.mixed, true);
  assert.equal(store.get(fresh.id)?.original, "हैवेल्स का bulb");
  store.close();
});

test("text is pruned after the retention window and audio after its own, shorter one", () => {
  const { store, settingsPath } = storeIn(tempDir("kelly-tp-"));
  updateVoiceSettings(settingsPath, { recordAudio: true, retentionDays: 60, audioRetentionDays: 7 });
  const now = new Date("2026-09-21T12:00:00.000Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  const fresh = store.record({ surface: "telegram", text: "fresh", at: daysAgo(1) });
  const oldAudio = store.record({ surface: "telegram", text: "ten days old", at: daysAgo(10) });
  const ancient = store.record({ surface: "counter", text: "seventy days old", at: daysAgo(70) });
  // Every write prunes, so a transcript already past the window never survives its own insert.
  assert.equal(store.get(ancient.id), undefined, "a 70-day-old transcript is pruned on write");
  const freshClip = store.saveAudio(fresh.id, Buffer.from("RIFF1WAVE"));
  const oldClip = store.saveAudio(oldAudio.id, Buffer.from("RIFF2WAVE"));
  assert.ok(freshClip && oldClip);
  assert.equal(store.saveAudio(ancient.id, Buffer.from("RIFF3WAVE")), undefined, "no clip is ever written for a pruned transcript");

  const result = store.prune(now);
  assert.equal(result.textDeleted, 0, "nothing else has aged out of the text window");
  assert.equal(store.get(oldAudio.id)?.text, "ten days old", "ten days is inside the text window");
  assert.equal(fs.existsSync(oldClip), false, "but outside the audio window");
  assert.equal(store.audioPath(oldAudio.id), undefined);
  assert.equal(fs.existsSync(freshClip), true, "yesterday's clip stays");
  store.close();
});

/* ------------------------------------------------------------------ *
 * 4. Usage: the CLIs' own numbers, aggregated by local day
 * ------------------------------------------------------------------ */

test("providerUsage reads Codex turn.completed and Claude result usage, and nothing else", () => {
  const ev = (parsed: Record<string, unknown>) => ({ timestamp: "", stream: "stdout" as const, text: "", parsed });
  assert.deepEqual(
    providerUsage([ev({ type: "item.completed" }), ev({ type: "turn.completed", usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122 } })], "codex"),
    { input: 24763, cached: 24448, output: 122 },
  );
  assert.deepEqual(
    providerUsage([ev({ type: "result", usage: { input_tokens: 900, cache_read_input_tokens: 600, output_tokens: 40 } })], "claude"),
    { input: 900, cached: 600, output: 40 },
  );
  assert.equal(providerUsage([ev({ type: "turn.completed", usage: { input_tokens: 1 } })], "claude"), undefined, "a Codex event never counts for Claude");
  assert.equal(providerUsage([ev({ text: "hello" })], "codex"), undefined);
});

test("summarizeUsage buckets runs, tokens, provider time and voice seconds by local day", () => {
  const now = new Date(2026, 8, 21, 15, 0, 0);
  const at = (daysAgo: number, hour = 10) => { const d = new Date(now); d.setDate(d.getDate() - daysAgo); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
  const event = (kind: ActivityEvent["kind"], timestamp: string, metadata: Record<string, unknown>): ActivityEvent => ({ id: `${kind}-${timestamp}`, timestamp, kind, message: kind, metadata });
  const events: ActivityEvent[] = [
    event("run.completed", at(0, 9), { durationMs: 8400, firstTextMs: 2200, usage: { input: 4120, cached: 3900, output: 122 } }),
    event("run.completed", at(0, 11), { durationMs: 6100, firstTextMs: 1900, usage: { input: 3000, cached: 2500, output: 80 } }),
    event("run.failed", at(0, 12), { error: "boom" }),
    event("voice.transcribed", at(0, 13), { durationSeconds: 6, sttMs: 4100 }),
    event("voice.tts", at(0, 13), { chars: 100, ms: 200, sentence: false }),
    event("voice.tts", at(0, 14), { chars: 50, ms: 150, sentence: true }),
    event("run.completed", at(2, 10), { durationMs: 20000 }),
    event("run.completed", at(9, 10), { durationMs: 1, usage: { input: 999999, cached: 0, output: 0 } }),
  ];
  const summary = summarizeUsage(events, {}, now, 7);
  assert.equal(summary.days.length, 7);
  assert.equal(summary.today.runs, 2);
  assert.equal(summary.today.failedRuns, 1);
  assert.equal(summary.today.inputTokens, 7120);
  assert.equal(summary.today.cachedTokens, 6400);
  assert.equal(summary.today.outputTokens, 202);
  assert.equal(summary.today.providerMs, 14500);
  assert.equal(summary.today.voiceSeconds, 6);
  assert.equal(summary.days[4].runs, 1, "two days ago sits four slots in");
  assert.equal(summary.days.reduce((n, d) => n + d.inputTokens, 0), 7120, "a run outside the window never counts");
  assert.equal(summary.latency.samples, 3);
  assert.equal(summary.latency.p50Ms, 8400);
  assert.equal(summary.latency.p95Ms, 20000);
  assert.equal(summary.latency.p50FirstTextMs, 1900, "the lower of the two first-text samples");
  assert.equal(summary.voice.realTimeFactor, 0.68);
  assert.equal(summary.voice.ttsChars, 150);
  assert.equal(summary.voice.ttsMs, 350);
  assert.equal(summary.voice.ttsP50MsPer100Chars, 200);
  assert.equal(summary.tokenCoverage, 0.67, "one of three runs in the window printed no tokens");
});

/* ------------------------------------------------------------------ *
 * 5. The routes, end to end on a loopback server
 * ------------------------------------------------------------------ */

test("dashboard serves transcript history, settings, and usage, and never leaks audio that is not kept", async () => {
  setActiveProfile("kelly");
  const root = tempDir("kelly-voice-routes-");
  fs.cpSync(path.join(process.cwd(), "workflows"), path.join(root, "workflows"), { recursive: true });
  const runtime = await HenryRuntime.create(root);
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";
  const server = startDashboard(runtime);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const initial = await (await fetch(`${base}/api/voice/settings`)).json() as { settings: { retentionDays: number; recordAudio: boolean }; stats: { total: number } };
    assert.equal(initial.settings.retentionDays, 60);
    assert.equal(initial.settings.recordAudio, false);
    assert.equal(initial.stats.total, 0);

    const row = runtime.voiceTranscripts.record({ surface: "telegram", text: "Havells ke do fan ka quote", language: "hi", durationSeconds: 5, sttMs: 3000 });
    const list = await (await fetch(`${base}/api/voice/transcripts?surface=telegram`)).json() as { transcripts: Array<{ id: string; text: string; audio: boolean; audioPath?: string; entities: { brands: string[] } }> };
    assert.equal(list.transcripts.length, 1);
    assert.equal(list.transcripts[0].id, row.id);
    assert.equal(list.transcripts[0].audio, false);
    assert.equal(list.transcripts[0].audioPath, undefined, "a filesystem path never leaves the server");
    assert.deepEqual(list.transcripts[0].entities.brands, ["Havells"]);

    const missingAudio = await fetch(`${base}/api/voice/audio/${row.id}`);
    assert.equal(missingAudio.status, 404, "no recording is kept, so none is served");

    const changed = await (await fetch(`${base}/api/voice/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recordAudio: true, retentionDays: 30 }) })).json() as { settings: { retentionDays: number; recordAudio: boolean } };
    assert.deepEqual(changed.settings, { retentionDays: 30, recordAudio: true, audioRetentionDays: 7, counterMode: "review" });

    const usage = await (await fetch(`${base}/api/usage`)).json() as { windowDays: number; days: unknown[]; limits: Record<string, unknown>; today: { runs: number } };
    assert.equal(usage.windowDays, 7);
    assert.equal(usage.days.length, 7);
    assert.deepEqual(usage.limits, {});
    assert.equal(usage.today.runs, 0);

    const notFound = await fetch(`${base}/api/voice/transcripts/does-not-exist`);
    assert.equal(notFound.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    runtime.close();
    setActiveProfile("henry");
  }
});
