import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { readSettings, updateSettings } from "../util/settings.ts";

/**
 * VOICE TRANSCRIPT STORE — what Kelly heard, kept on the owner's terms.
 *
 * Until now both voice surfaces kept the words OUT of the activity log on purpose: a
 * transcript is the customer's speech, and a log line is forever. This store is the
 * explicit, owner-controlled alternative:
 *
 * - text is kept for `retentionDays` (default 60) and pruned on every write;
 * - audio is written ONLY while `recordAudio` is on (default OFF), and kept for
 *   `audioRetentionDays` (default 7), pruned independently of the text;
 * - everything lives under `<dataDir>/voice/` with 0600/0700 modes, never leaves the
 *   machine, and is never committed.
 *
 * SQLite (WAL) rather than JSON because the dashboard, the Telegram bridge and a CLI
 * one-shot can all write at once, and a transaction closes the read-modify-write race that
 * JSON stores had (the 2026-08-06 reminders-cache clobber lesson).
 *
 * A transcript's STATE tells the owner what happened to the words:
 *   transcribed → armed for a typed yes (Telegram) or shown for review (counter)
 *   confirmed   → the owner typed yes; the words went to the brain
 *   answered    → Kelly replied (reply text stored beside the transcript)
 *   dropped     → the owner typed no, or typed something else instead
 *   expired     → nobody confirmed within the window
 *   failed      → download, conversion, or transcription failed (no words kept)
 */

/**
 * `counterMode` picks which of the two counter-tablet experiences `voice.html` /
 * `counter.html` present: "review" (default) is today's flow — a transcript is shown and
 * the owner/operator types "send" to confirm before it reaches Kelly. "conversation" skips
 * that review step: transcripts go straight to Kelly and replies are spoken back. "talk" is
 * the hands-free counter loop (Kelly Talk): the page greets, listens, replies, and listens
 * again with no tap between turns. It is a durable setting (`voice.counterMode` in
 * `data/settings.json`), with `KELLY_COUNTER_MODE` as a process-level override — set, valid,
 * and it wins over whatever is persisted; set and invalid, it is ignored and the
 * persisted/default value applies instead.
 */
export type CounterMode = "review" | "conversation" | "talk";

export function isCounterMode(value: unknown): value is CounterMode {
  return value === "review" || value === "conversation" || value === "talk";
}

/**
 * `counterTier` opts a voice/counter turn into a faster Codex dispatch tier (see
 * `DispatchTier`/`resolveProviderRoute` in `src/providers/runner.ts`). "auto" (default) leaves
 * today's routing untouched — `src/agent/henry.ts` picks the tier itself
 * (`options.tier ?? routeIntentTier(prompt)`). "t0"/"t1" pin a voice turn's tier explicitly, the
 * same way a caller can already pin `RunOptions.tier`. It is a durable setting
 * (`voice.counterTier` in `data/settings.json`), with `KELLY_COUNTER_TIER` as a process-level
 * override — set, valid, and it wins over whatever is persisted; set and invalid, it is ignored
 * and the persisted/default value applies instead. Non-voice turns never read this setting.
 */
export type CounterTier = "auto" | "t0" | "t1";

export function isCounterTier(value: unknown): value is CounterTier {
  return value === "auto" || value === "t0" || value === "t1";
}

export interface VoiceSettings {
  retentionDays: number;
  recordAudio: boolean;
  audioRetentionDays: number;
  counterMode: CounterMode;
  counterTier: CounterTier;
}

export const VOICE_SETTINGS_DEFAULTS: Readonly<VoiceSettings> = Object.freeze({
  retentionDays: 60,
  recordAudio: false,
  audioRetentionDays: 7,
  counterMode: "review",
  counterTier: "auto",
});

const RETENTION_RANGE = { min: 1, max: 365 };
const AUDIO_RETENTION_RANGE = { min: 1, max: 90 };

function clampDays(value: unknown, fallback: number, range: { min: number; max: number }): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(parsed)));
}

/** Reads persisted `settings.json → voice` only, with no env override applied — the shape
 *  `updateVoiceSettings` reads-merges-writes against, so a shadowing env var can never leak
 *  into what actually gets saved. */
function readPersistedVoiceSettings(settingsPath: string): VoiceSettings {
  const raw = readSettings(settingsPath).voice;
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    retentionDays: clampDays(record.retentionDays, VOICE_SETTINGS_DEFAULTS.retentionDays, RETENTION_RANGE),
    recordAudio: record.recordAudio === true,
    audioRetentionDays: clampDays(record.audioRetentionDays, VOICE_SETTINGS_DEFAULTS.audioRetentionDays, AUDIO_RETENTION_RANGE),
    counterMode: isCounterMode(record.counterMode) ? record.counterMode : VOICE_SETTINGS_DEFAULTS.counterMode,
    counterTier: isCounterTier(record.counterTier) ? record.counterTier : VOICE_SETTINGS_DEFAULTS.counterTier,
  };
}

/** `settings.json → voice`. Missing or malformed reads as the defaults. `KELLY_COUNTER_MODE`,
 *  when set to a valid mode, overrides whatever is persisted for THIS read; an invalid value
 *  is ignored. The override is process-scoped display/behaviour only — see
 *  `readPersistedVoiceSettings` for what `updateVoiceSettings` actually saves. */
export function readVoiceSettings(settingsPath: string, env: NodeJS.ProcessEnv = process.env): VoiceSettings {
  const persisted = readPersistedVoiceSettings(settingsPath);
  const envOverride = env.KELLY_COUNTER_MODE;
  const tierOverride = env.KELLY_COUNTER_TIER;
  return {
    ...persisted,
    counterMode: isCounterMode(envOverride) ? envOverride : persisted.counterMode,
    counterTier: isCounterTier(tierOverride) ? tierOverride : persisted.counterTier,
  };
}

/** Read-merge-write through the shared settings helper; returns what is now in force
 *  (including any live `KELLY_COUNTER_MODE` override). Persistence itself is always against
 *  the on-disk value, never the env-shadowed one, so an override never gets baked in by a
 *  save the admin made for something else entirely. */
export function updateVoiceSettings(settingsPath: string, patch: Partial<VoiceSettings>): VoiceSettings {
  const current = readPersistedVoiceSettings(settingsPath);
  const next: VoiceSettings = {
    retentionDays: patch.retentionDays === undefined ? current.retentionDays : clampDays(patch.retentionDays, current.retentionDays, RETENTION_RANGE),
    recordAudio: patch.recordAudio === undefined ? current.recordAudio : patch.recordAudio === true,
    audioRetentionDays: patch.audioRetentionDays === undefined ? current.audioRetentionDays : clampDays(patch.audioRetentionDays, current.audioRetentionDays, AUDIO_RETENTION_RANGE),
    counterMode: patch.counterMode === undefined ? current.counterMode : isCounterMode(patch.counterMode) ? patch.counterMode : current.counterMode,
    counterTier: patch.counterTier === undefined ? current.counterTier : isCounterTier(patch.counterTier) ? patch.counterTier : current.counterTier,
  };
  updateSettings(settingsPath, { voice: next });
  return readVoiceSettings(settingsPath);
}

export type TranscriptSurface = "counter" | "telegram";
export type TranscriptState = "transcribed" | "confirmed" | "answered" | "dropped" | "expired" | "failed";

export interface TranscriptEntities {
  brands: string[];
  quantities: string[];
  units: string[];
  /** True when neither a brand nor a quantity was heard: Kelly should ask, not guess. */
  sparse: boolean;
}

export interface TranscriptRecord {
  id: string;
  at: string;
  surface: TranscriptSurface;
  language?: string;
  durationSeconds?: number;
  bytes?: number;
  /** Wall-clock transcription time, for latency and real-time factor. */
  sttMs?: number;
  /** Whisper's native transcript, including Devanagari and Latin text. What the owner reads. */
  text: string;
  /** Legacy pre-conversion words from records created while Roman Hinglish conversion was active.
   *  New records preserve Whisper's native output directly and leave this field empty. */
  original?: string;
  /** True when `original` is present — Whisper's own output contained Devanagari. */
  mixed: boolean;
  /** Opaque authenticated dashboard principal that created a counter transcript. */
  principal?: string;
  entities: TranscriptEntities;
  state: TranscriptState;
  conversationId?: string;
  reply?: string;
  replyAt?: string;
  /** Present only while a recording is kept on disk. */
  audioPath?: string;
  error?: string;
}

export interface TranscriptFilter {
  surface?: TranscriptSurface;
  language?: string;
  state?: TranscriptState;
  /** Case-insensitive substring over the words and the reply. */
  q?: string;
  /** Only transcripts where Kelly would have had to ask (no brand and no quantity). */
  sparse?: boolean;
  limit?: number;
}

export interface TranscriptStats {
  total: number;
  today: number;
  bySurface: Record<TranscriptSurface, number>;
  unconfirmed: number;
  failed: number;
  audioKept: number;
}

/* ------------------------------------------------------------------ *
 * Entity extraction: deterministic, conservative, and only for display
 * ------------------------------------------------------------------ */

/** Brands spoken at an Indian electrical counter, Latin and Devanagari spellings side by side. */
const BRANDS: Array<[canonical: string, pattern: RegExp]> = [
  ["Havells", /\bhavells?\b|हैवेल्स|हैवल्स/i],
  ["Philips", /\bphilips\b|फिलिप्स/i],
  ["Crompton", /\bcrompton\b|क्रॉम्पटन|क्रॉम्प्टन/i],
  ["Anchor", /\banchor\b|एंकर|ऐंकर/i],
  ["Polycab", /\bpolycab\b|पॉलीकैब|पोलीकैब/i],
  ["Finolex", /\bfinolex\b|फिनोलेक्स/i],
  ["Legrand", /\blegrand\b|लेग्रैंड|लेग्रांड/i],
  ["Orient", /\borient\b|ओरिएंट/i],
  ["Bajaj", /\bbajaj\b|बजाज/i],
  ["V-Guard", /\bv[\s-]?guard\b|वी[\s-]?गार्ड/i],
  ["Syska", /\bsyska\b|सिस्का/i],
  ["Usha", /\busha\b|उषा/i],
  ["Luminous", /\bluminous\b|ल्यूमिनस/i],
  ["Racold", /\bracold\b|रैकोल्ड/i],
  ["Schneider", /\bschneider\b|श्नाइडर/i],
  ["Siemens", /\bsiemens\b|सीमेंस/i],
  ["ABB", /\babb\b/i],
  ["Goldmedal", /\bgold\s?medal\b|गोल्डमेडल/i],
  ["Wipro", /\bwipro\b|विप्रो/i],
  ["Atomberg", /\batomberg\b|एटमबर्ग/i],
];

/** A number, a spelled number, or Indian number words, followed by a unit that changes the product. */
const UNIT = String.raw`(sq\.?\s?mm|sqmm|mm|kva|kw|kilowatt|w|watt|वाट|वॉट|amp(?:ere)?s?|a|v|volts?|वोल्ट|m|mtr|meters?|metres?|मीटर|ft|feet|pcs?|pieces?|पीस|nos|coils?|box(?:es)?|packets?|lengths?|units?|hp)`;
const NUMBER = String.raw`(\d+(?:[.,]\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty|fifty|hundred|ek|do|teen|char|paanch|panch|chhe|saat|aath|nau|das|dedh|sawa|adhai|sau|hazaar|hazar|lakh|एक|दो|तीन|चार|पाँच|पांच|छह|सात|आठ|नौ|दस|बीस|पचास|सौ|डेढ़|सवा|ढाई|हज़ार|हजार|लाख)`;
const QUANTITY = new RegExp(`${NUMBER}(?:\\s+(?:point|पॉइंट)\\s+${NUMBER})?\\s*${UNIT}(?![\\p{L}])`, "giu");
const UNIT_ONLY = new RegExp(`\\b${UNIT}\\b`, "giu");

function canonicalUnit(raw: string): string {
  const u = raw.toLowerCase().replace(/\s+/g, "").replace(".", "");
  if (/^sqmm$/.test(u)) return "sq mm";
  if (/^(w|watt|वाट|वॉट)$/.test(u)) return "W";
  if (/^(kw|kilowatt)$/.test(u)) return "kW";
  if (u === "kva") return "kVA";
  if (/^(a|amp|amps|ampere|amperes)$/.test(u)) return "A";
  if (/^(v|volt|volts|वोल्ट)$/.test(u)) return "V";
  if (/^(m|mtr|meter|meters|metre|metres|मीटर)$/.test(u)) return "m";
  if (/^(ft|feet)$/.test(u)) return "ft";
  if (/^(pc|pcs|piece|pieces|पीस|nos|unit|units)$/.test(u)) return "pc";
  if (/^(coil|coils)$/.test(u)) return "coil";
  if (/^(box|boxes)$/.test(u)) return "box";
  if (/^(packet|packets)$/.test(u)) return "packet";
  if (/^(length|lengths)$/.test(u)) return "length";
  if (u === "hp") return "hp";
  return u;
}

/**
 * What survived transcription that a quotation depends on. This never feeds the brain or a
 * calculation; it is a display aid so the owner can see at a glance whether a brand and a
 * quantity were heard, and the evaluation harness can measure preservation.
 */
export function extractEntities(text: string): TranscriptEntities {
  const brands: string[] = [];
  for (const [name, pattern] of BRANDS) if (pattern.test(text)) brands.push(name);
  const quantities: string[] = [];
  const units = new Set<string>();
  for (const match of text.matchAll(QUANTITY)) {
    const span = match[0].replace(/\s+/g, " ").trim();
    quantities.push(span);
    const unit = match[match.length - 1];
    if (unit) units.add(canonicalUnit(unit));
  }
  for (const match of text.matchAll(UNIT_ONLY)) units.add(canonicalUnit(match[1] ?? match[0]));
  return { brands, quantities, units: [...units], sparse: brands.length === 0 && quantities.length === 0 };
}

/**
 * Union of brands seen in the Roman text and the original (pre-conversion) script, so a
 * Devanagari brand spelling that the Roman conversion missed still counts. Quantities and
 * units come from the Roman text alone (that pass already reads the Devanagari number words
 * directly); `sparse` is recomputed against the merged brand list.
 */
function mergeEntities(primary: TranscriptEntities, original?: string): TranscriptEntities {
  if (!original) return primary;
  const fromOriginal = extractEntities(original);
  const brands = [...primary.brands];
  for (const brand of fromOriginal.brands) if (!brands.includes(brand)) brands.push(brand);
  return { brands, quantities: primary.quantities, units: primary.units, sparse: brands.length === 0 && primary.quantities.length === 0 };
}

/* ------------------------------------------------------------------ *
 * The store
 * ------------------------------------------------------------------ */

interface Row {
  id: string; at: string; surface: string; language: string | null; durationSeconds: number | null;
  bytes: number | null; sttMs: number | null; text: string; original: string | null; entities: string; state: string;
  principal: string | null; conversationId: string | null; reply: string | null; replyAt: string | null; audioPath: string | null; error: string | null;
}

const SURFACES: TranscriptSurface[] = ["counter", "telegram"];
const STATES: TranscriptState[] = ["transcribed", "confirmed", "answered", "dropped", "expired", "failed"];

export function isTranscriptSurface(value: unknown): value is TranscriptSurface {
  return typeof value === "string" && (SURFACES as string[]).includes(value);
}
export function isTranscriptState(value: unknown): value is TranscriptState {
  return typeof value === "string" && (STATES as string[]).includes(value);
}

export class VoiceTranscriptStore {
  private readonly db: Database.Database;
  private readonly dir: string;

  constructor(private readonly dataDir: string, private readonly settingsPath: string) {
    this.dir = path.join(dataDir, "voice");
    fs.mkdirSync(path.join(this.dir, "audio"), { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(this.dir, "transcripts.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS transcripts (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      surface TEXT NOT NULL,
      language TEXT,
      durationSeconds REAL,
      bytes INTEGER,
      sttMs INTEGER,
      text TEXT NOT NULL,
      original TEXT,
      principal TEXT,
      entities TEXT NOT NULL,
      state TEXT NOT NULL,
      conversationId TEXT,
      reply TEXT,
      replyAt TEXT,
      audioPath TEXT,
      error TEXT
    )`);
    // A database created before `original` existed: add the column rather than requiring a
    // fresh one. PRAGMA table_info is the guard — CREATE TABLE IF NOT EXISTS above is a no-op
    // against an existing table, so this is the only path an old database's schema is updated.
    const columns = this.db.prepare("PRAGMA table_info(transcripts)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "original")) {
      this.db.exec("ALTER TABLE transcripts ADD COLUMN original TEXT");
    }
    if (!columns.some((column) => column.name === "principal")) {
      this.db.exec("ALTER TABLE transcripts ADD COLUMN principal TEXT");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS transcripts_at ON transcripts(at DESC)");
    try { fs.chmodSync(path.join(this.dir, "transcripts.db"), 0o600); } catch { /* best effort */ }
  }

  settings(): VoiceSettings { return readVoiceSettings(this.settingsPath); }

  /** Writes a transcript (or a failure with no words) and prunes what has aged out. */
  record(input: {
    surface: TranscriptSurface; text: string; original?: string; principal?: string; language?: string; durationSeconds?: number; bytes?: number;
    sttMs?: number; state?: TranscriptState; conversationId?: string; error?: string; at?: string;
  }): TranscriptRecord {
    // `original` is kept only when it actually differs from the (Roman) text — a caller that
    // always passes Whisper's raw output must not store a duplicate of unchanged English.
    const original = input.original !== undefined && input.original !== input.text ? input.original : undefined;
    const record: TranscriptRecord = {
      id: randomUUID(),
      at: input.at ?? new Date().toISOString(),
      surface: input.surface,
      ...(input.language ? { language: input.language } : {}),
      ...(input.durationSeconds !== undefined ? { durationSeconds: input.durationSeconds } : {}),
      ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
      ...(input.sttMs !== undefined ? { sttMs: input.sttMs } : {}),
      text: input.text,
      ...(original ? { original } : {}),
      mixed: Boolean(original),
      ...(input.principal ? { principal: input.principal } : {}),
      entities: mergeEntities(extractEntities(input.text), original),
      state: input.state ?? (input.error ? "failed" : "transcribed"),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.error ? { error: input.error } : {}),
    };
    this.db.prepare(`INSERT INTO transcripts (id, at, surface, language, durationSeconds, bytes, sttMs, text, original, principal, entities, state, conversationId, reply, replyAt, audioPath, error)
      VALUES (@id, @at, @surface, @language, @durationSeconds, @bytes, @sttMs, @text, @original, @principal, @entities, @state, @conversationId, NULL, NULL, NULL, @error)`).run({
      id: record.id, at: record.at, surface: record.surface, language: record.language ?? null,
      durationSeconds: record.durationSeconds ?? null, bytes: record.bytes ?? null, sttMs: record.sttMs ?? null,
      text: record.text, original: original ?? null, principal: input.principal ?? null, entities: JSON.stringify(record.entities), state: record.state,
      conversationId: record.conversationId ?? null, error: record.error ?? null,
    });
    this.prune();
    return record;
  }

  /** State transitions and the reply, from whichever surface learns them. */
  update(id: string, patch: { state?: TranscriptState; reply?: string; conversationId?: string; error?: string }): TranscriptRecord | undefined {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.state) { sets.push("state = @state"); params.state = patch.state; }
    if (patch.reply !== undefined) { sets.push("reply = @reply", "replyAt = @replyAt"); params.reply = patch.reply; params.replyAt = new Date().toISOString(); }
    if (patch.conversationId !== undefined) { sets.push("conversationId = @conversationId"); params.conversationId = patch.conversationId; }
    if (patch.error !== undefined) { sets.push("error = @error"); params.error = patch.error; }
    if (sets.length) this.db.prepare(`UPDATE transcripts SET ${sets.join(", ")} WHERE id = @id`).run(params);
    return this.get(id);
  }

  get(id: string): TranscriptRecord | undefined {
    const row = this.db.prepare("SELECT * FROM transcripts WHERE id = ?").get(id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(filter: TranscriptFilter = {}): TranscriptRecord[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.surface) { where.push("surface = @surface"); params.surface = filter.surface; }
    if (filter.state) { where.push("state = @state"); params.state = filter.state; }
    if (filter.language) { where.push("language = @language"); params.language = filter.language; }
    if (filter.q?.trim()) { where.push("(lower(text) LIKE @q OR lower(coalesce(original, '')) LIKE @q OR lower(coalesce(reply, '')) LIKE @q)"); params.q = `%${filter.q.trim().toLowerCase()}%`; }
    const limit = Math.min(500, Math.max(1, Math.round(filter.limit ?? 100)));
    const rows = this.db.prepare(`SELECT * FROM transcripts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC LIMIT ${limit}`).all(params) as Row[];
    const records = rows.map(fromRow);
    return filter.sparse ? records.filter((record) => record.entities.sparse) : records;
  }

  stats(now: Date = new Date()): TranscriptStats {
    const rows = this.db.prepare("SELECT surface, state, at, audioPath FROM transcripts").all() as Array<Pick<Row, "surface" | "state" | "at" | "audioPath">>;
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const stats: TranscriptStats = { total: rows.length, today: 0, bySurface: { counter: 0, telegram: 0 }, unconfirmed: 0, failed: 0, audioKept: 0 };
    for (const row of rows) {
      if (new Date(row.at).getTime() >= dayStart.getTime()) stats.today += 1;
      if (isTranscriptSurface(row.surface)) stats.bySurface[row.surface] += 1;
      if (row.state === "transcribed") stats.unconfirmed += 1;
      if (row.state === "failed") stats.failed += 1;
      if (row.audioPath) stats.audioKept += 1;
    }
    return stats;
  }

  /**
   * Keeps a recording ONLY while the owner has switched recording on. Returns the path, or
   * undefined when nothing was written, so callers never have to check the setting themselves.
   */
  saveAudio(id: string, wav: Uint8Array): string | undefined {
    if (!this.settings().recordAudio) return undefined;
    if (!this.get(id)) return undefined;
    const target = path.join(this.dir, "audio", `${id}.wav`);
    fs.writeFileSync(target, wav, { mode: 0o600 });
    this.db.prepare("UPDATE transcripts SET audioPath = ? WHERE id = ?").run(target, id);
    return target;
  }

  /** The kept recording's path, or undefined when none is (or no longer is) on disk. */
  audioPath(id: string): string | undefined {
    const record = this.get(id);
    if (!record?.audioPath) return undefined;
    try { fs.accessSync(record.audioPath); return record.audioPath; } catch { return undefined; }
  }

  /** Text older than the retention window is deleted; audio older than its own window is unlinked. */
  prune(now: Date = new Date()): { textDeleted: number; audioDeleted: number } {
    const settings = this.settings();
    const textCutoff = new Date(now.getTime() - settings.retentionDays * 86_400_000).toISOString();
    const audioCutoff = new Date(now.getTime() - settings.audioRetentionDays * 86_400_000).toISOString();
    const expiredAudio = this.db.prepare("SELECT id, audioPath FROM transcripts WHERE audioPath IS NOT NULL AND at < ?").all(audioCutoff) as Array<Pick<Row, "id" | "audioPath">>;
    for (const row of expiredAudio) {
      if (row.audioPath) try { fs.unlinkSync(row.audioPath); } catch { /* already gone */ }
      this.db.prepare("UPDATE transcripts SET audioPath = NULL WHERE id = ?").run(row.id);
    }
    const expiredText = this.db.prepare("SELECT audioPath FROM transcripts WHERE at < ?").all(textCutoff) as Array<Pick<Row, "audioPath">>;
    for (const row of expiredText) if (row.audioPath) try { fs.unlinkSync(row.audioPath); } catch { /* already gone */ }
    const deleted = this.db.prepare("DELETE FROM transcripts WHERE at < ?").run(textCutoff).changes;
    return { textDeleted: deleted, audioDeleted: expiredAudio.length };
  }

  /** Switching recording off also removes every kept recording: "off" must mean nothing on disk. */
  discardAllAudio(): number {
    const rows = this.db.prepare("SELECT id, audioPath FROM transcripts WHERE audioPath IS NOT NULL").all() as Array<Pick<Row, "id" | "audioPath">>;
    for (const row of rows) {
      if (row.audioPath) try { fs.unlinkSync(row.audioPath); } catch { /* already gone */ }
      this.db.prepare("UPDATE transcripts SET audioPath = NULL WHERE id = ?").run(row.id);
    }
    return rows.length;
  }

  close(): void { this.db.close(); }
}

function fromRow(row: Row): TranscriptRecord {
  let entities: TranscriptEntities;
  try { entities = JSON.parse(row.entities) as TranscriptEntities; } catch { entities = { brands: [], quantities: [], units: [], sparse: true }; }
  return {
    id: row.id, at: row.at,
    surface: isTranscriptSurface(row.surface) ? row.surface : "counter",
    ...(row.language ? { language: row.language } : {}),
    ...(row.durationSeconds !== null ? { durationSeconds: row.durationSeconds } : {}),
    ...(row.bytes !== null ? { bytes: row.bytes } : {}),
    ...(row.sttMs !== null ? { sttMs: row.sttMs } : {}),
    text: row.text,
    ...(row.original ? { original: row.original } : {}),
    mixed: Boolean(row.original),
    ...(row.principal ? { principal: row.principal } : {}),
    entities,
    state: isTranscriptState(row.state) ? row.state : "transcribed",
    ...(row.conversationId ? { conversationId: row.conversationId } : {}),
    ...(row.reply !== null ? { reply: row.reply } : {}),
    ...(row.replyAt ? { replyAt: row.replyAt } : {}),
    ...(row.audioPath ? { audioPath: row.audioPath } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}
