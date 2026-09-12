import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { HenryConfig } from "../config.ts";

/**
 * Standup persistence (data/standups.db, WAL) — raw group updates, daily summaries,
 * per-person style profiles, and poller bookkeeping (getUpdates offset + single-consumer
 * lock). SQLite like sessions.db, not JSON: the poller, the scan cron, and CLI one-shots
 * can all touch this concurrently, and transactions close the read-modify-write races
 * that JSON stores had (the 2026-08-06 reminders-cache clobber lesson).
 */

export const UPDATE_QUALITIES = ["ok", "vague", "offtopic"] as const;
export type UpdateQuality = (typeof UPDATE_QUALITIES)[number];

export function isUpdateQuality(value: string): value is UpdateQuality {
  return (UPDATE_QUALITIES as readonly string[]).includes(value);
}

/** Structured content the scan pass extracts from one update — stored as JSON in `parsed`. */
export interface ParsedStandup {
  yesterday: string[];
  today: string[];
  blockers: string[];
}

export interface StandupUpdateRow {
  id: number;
  chatId: string;
  messageId: number;
  userId: string;
  userName: string;
  /** IST day bucket "YYYY-MM-DD" — standups belong to the day the team lives in, not UTC. */
  date: string;
  /** morning (plans) or evening (progress) — see `istSessionKey`. */
  session: StandupSession;
  text: string;
  receivedAt: string;
  edited: number;
  quality: UpdateQuality | null;
  parsed: ParsedStandup | null;
  clarified: number;
}

export interface StyleRow {
  userId: string;
  userName: string;
  /** Free-text profile: register, length, emoji habits, language mix, quirks. */
  profile: string;
  samplesSeen: number;
  updatedAt: string;
}

/** Telegram `message.date` is epoch seconds UTC; bucket it into the IST calendar day. */
export function istDateKey(epochSeconds: number): string {
  return new Date((epochSeconds + 5.5 * 3600) * 1000).toISOString().slice(0, 10);
}

export const STANDUP_SESSIONS = ["morning", "evening"] as const;
export type StandupSession = (typeof STANDUP_SESSIONS)[number];

/**
 * Two daily cycles: the morning standup (plans) and the night progress check.
 * A message posted before 15:00 IST belongs to the morning session; later ones
 * are evening progress updates. 15:00 splits the noon-summary tail from the
 * ~19:30 evening prompt with slack on both sides.
 */
export function istSessionKey(epochSeconds: number): StandupSession {
  const istHour = new Date((epochSeconds + 5.5 * 3600) * 1000).getUTCHours();
  return istHour < 15 ? "morning" : "evening";
}

interface RawUpdateRow extends Omit<StandupUpdateRow, "parsed"> { parsed: string | null }

function hydrate(row: RawUpdateRow): StandupUpdateRow {
  let parsed: ParsedStandup | null = null;
  if (row.parsed) {
    try { parsed = JSON.parse(row.parsed) as ParsedStandup; } catch { parsed = null; }
  }
  return { ...row, parsed };
}

export class StandupStore {
  private readonly db: Database.Database;

  constructor(config: HenryConfig) {
    fs.mkdirSync(path.dirname(config.standupDbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(config.standupDbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatId TEXT NOT NULL,
        messageId INTEGER NOT NULL,
        userId TEXT NOT NULL,
        userName TEXT NOT NULL,
        date TEXT NOT NULL,
        session TEXT NOT NULL DEFAULT 'morning',
        text TEXT NOT NULL,
        receivedAt TEXT NOT NULL,
        edited INTEGER NOT NULL DEFAULT 0,
        quality TEXT,
        parsed TEXT,
        clarified INTEGER NOT NULL DEFAULT 0,
        UNIQUE(chatId, messageId)
      );
      CREATE INDEX IF NOT EXISTS idx_updates_date ON updates(date);
      CREATE TABLE IF NOT EXISTS summaries (
        date TEXT NOT NULL,
        session TEXT NOT NULL DEFAULT 'morning',
        markdown TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (date, session)
      );
      CREATE TABLE IF NOT EXISTS styles (
        userId TEXT PRIMARY KEY,
        userName TEXT NOT NULL,
        profile TEXT NOT NULL,
        samplesSeen INTEGER NOT NULL DEFAULT 0,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.migrate();
  }

  /**
   * Same-day schema catch-up for databases created before the two-session split.
   * `updates` gains the session column in place; a single-PK `summaries` table is
   * rebuilt (dropped, not copied — the durable artifacts are data/standups/*.md,
   * and the pre-migration table shipped the same day this migration did).
   */
  private migrate(): void {
    const updateCols = (this.db.pragma("table_info(updates)") as Array<{ name: string }>).map((col) => col.name);
    if (!updateCols.includes("session")) {
      this.db.exec("ALTER TABLE updates ADD COLUMN session TEXT NOT NULL DEFAULT 'morning'");
    }
    const summaryCols = (this.db.pragma("table_info(summaries)") as Array<{ name: string }>).map((col) => col.name);
    if (!summaryCols.includes("session")) {
      this.db.exec(`
        DROP TABLE summaries;
        CREATE TABLE summaries (
          date TEXT NOT NULL,
          session TEXT NOT NULL DEFAULT 'morning',
          markdown TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          PRIMARY KEY (date, session)
        );
      `);
    }
  }

  /**
   * Inserts a group message, or — for a Telegram edit of an already-stored message —
   * replaces its text and resets `quality`/`parsed` so the next scan re-reads it.
   * Returns whether the row was newly inserted (a re-delivered unedited message is a no-op).
   */
  upsertUpdate(input: {
    chatId: string; messageId: number; userId: string; userName: string;
    date: string; session?: StandupSession; text: string; edited?: boolean; now?: Date;
  }): { fresh: boolean } {
    const receivedAt = (input.now ?? new Date()).toISOString();
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id, text FROM updates WHERE chatId = ? AND messageId = ?")
        .get(input.chatId, input.messageId) as { id: number; text: string } | undefined;
      if (!existing) {
        this.db.prepare(
          "INSERT INTO updates (chatId, messageId, userId, userName, date, session, text, receivedAt, edited) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(input.chatId, input.messageId, input.userId, input.userName, input.date, input.session ?? "morning", input.text, receivedAt, input.edited ? 1 : 0);
        return { fresh: true };
      }
      if (input.edited && existing.text !== input.text) {
        this.db.prepare("UPDATE updates SET text = ?, edited = 1, quality = NULL, parsed = NULL WHERE id = ?")
          .run(input.text, existing.id);
      }
      return { fresh: false };
    })();
  }

  unscanned(date: string): StandupUpdateRow[] {
    return (this.db.prepare("SELECT * FROM updates WHERE date = ? AND quality IS NULL ORDER BY id").all(date) as RawUpdateRow[]).map(hydrate);
  }

  markQuality(id: number, quality: UpdateQuality, parsed?: ParsedStandup): void {
    this.db.prepare("UPDATE updates SET quality = ?, parsed = ? WHERE id = ?")
      .run(quality, parsed ? JSON.stringify(parsed) : null, id);
  }

  /** Real standup content for a day — scanned rows minus off-topic banter; optionally one session's. */
  contentForDate(date: string, session?: StandupSession): StandupUpdateRow[] {
    const rows = session
      ? this.db.prepare("SELECT * FROM updates WHERE date = ? AND session = ? AND quality IN ('ok','vague') ORDER BY id").all(date, session)
      : this.db.prepare("SELECT * FROM updates WHERE date = ? AND quality IN ('ok','vague') ORDER BY id").all(date);
    return (rows as RawUpdateRow[]).map(hydrate);
  }

  countsForDate(date: string, session?: StandupSession): { collected: number; unscanned: number; vague: number; clarified: number } {
    const query = `SELECT
      COUNT(*) AS collected,
      SUM(CASE WHEN quality IS NULL THEN 1 ELSE 0 END) AS unscanned,
      SUM(CASE WHEN quality = 'vague' THEN 1 ELSE 0 END) AS vague,
      SUM(CASE WHEN clarified = 1 THEN 1 ELSE 0 END) AS clarified
      FROM updates WHERE date = ?${session ? " AND session = ?" : ""}`;
    const row = (session ? this.db.prepare(query).get(date, session) : this.db.prepare(query).get(date)) as Record<string, number | null>;
    return {
      collected: row.collected ?? 0, unscanned: row.unscanned ?? 0,
      vague: row.vague ?? 0, clarified: row.clarified ?? 0,
    };
  }

  /** The ≤1-clarification-per-person-per-day rail reads this before any ping (runaway-reminder lesson). */
  clarifiedCountForDay(userId: string, date: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM updates WHERE userId = ? AND date = ? AND clarified = 1")
      .get(userId, date) as { n: number };
    return row.n;
  }

  markClarified(id: number): void {
    this.db.prepare("UPDATE updates SET clarified = 1 WHERE id = ?").run(id);
  }

  saveSummary(date: string, session: StandupSession, markdown: string, now: Date = new Date()): void {
    this.db.prepare(
      "INSERT INTO summaries (date, session, markdown, createdAt) VALUES (?, ?, ?, ?) ON CONFLICT(date, session) DO UPDATE SET markdown = excluded.markdown, createdAt = excluded.createdAt",
    ).run(date, session, markdown, now.toISOString());
  }

  getSummary(date: string, session: StandupSession = "morning"): { date: string; session: string; markdown: string; createdAt: string } | undefined {
    return this.db.prepare("SELECT * FROM summaries WHERE date = ? AND session = ?").get(date, session) as { date: string; session: string; markdown: string; createdAt: string } | undefined;
  }

  getStyle(userId: string): StyleRow | undefined {
    return this.db.prepare("SELECT * FROM styles WHERE userId = ?").get(userId) as StyleRow | undefined;
  }

  /** The roster: everyone ever seen posting — "Missing" in summaries is computed against this. */
  allStyles(): StyleRow[] {
    return this.db.prepare("SELECT * FROM styles ORDER BY userName").all() as StyleRow[];
  }

  /** Returns true when the profile text actually changed — the caller snapshots changed profiles to Engram. */
  upsertStyle(userId: string, userName: string, profile: string, addSamples: number, now: Date = new Date()): boolean {
    return this.db.transaction(() => {
      const existing = this.getStyle(userId);
      this.db.prepare(
        "INSERT INTO styles (userId, userName, profile, samplesSeen, updatedAt) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(userId) DO UPDATE SET userName = excluded.userName, profile = excluded.profile, samplesSeen = samplesSeen + ?, updatedAt = excluded.updatedAt",
      ).run(userId, userName, profile, addSamples, now.toISOString(), addSamples);
      return !existing || existing.profile !== profile;
    })();
  }

  getMeta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  deleteMeta(key: string): void {
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  }

  close(): void { this.db.close(); }
}
