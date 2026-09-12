import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { ProviderName } from "../types.ts";

/**
 * Per-surface provider session reuse (latency plan §11.5 #2, Friday's model).
 *
 * Every Henry turn used to spawn a cold `codex exec --ephemeral` / `claude -p`
 * that re-sent the full prompt with zero context reuse. A surface (repl,
 * dashboard-ask, luna::<role>, telegram) instead keeps one provider session
 * alive: the first turn creates it, later turns resume it — the provider
 * already holds the soul/persona/history, so turns get dramatically cheaper
 * and faster. Sessions are per (surface, provider) and reset on staleness,
 * explicit reset, or provider switch.
 *
 * RESUME-AFTER-DISCONNECT is the point of persistence: a crashed or killed
 * process (worker or main) leaves its session row behind, and the next
 * process that acquires the same surface resumes the SAME provider session —
 * claude `--resume <id>` / codex `exec resume <id>` restore the worker's
 * context. Storage is SQLite (data/sessions.db, WAL): every mutation is a
 * single transaction, which closes the JSON read-modify-write race the old
 * sessions.json had when REPL + dashboard + scheduler wrote concurrently
 * (2026-08-06 reminder-cache clobber lesson, upgraded from re-read to real
 * transactions). A legacy sessions.json is migrated once, then parked as
 * sessions.json.migrated.
 */

export interface SessionRecord {
  id: string;
  provider: ProviderName;
  surface: string;
  createdAt: string;
  lastUsedAt: string;
  turns: number;
}

export const SESSION_STALE_MS = 2 * 60 * 60 * 1000;
/** Cap turns per session so provider-side context never grows unbounded. */
export const SESSION_MAX_TURNS = 40;

function key(surface: string, provider: ProviderName): string {
  return `${surface}::${provider}`;
}

export class SessionManager {
  private readonly db: Database.Database;

  /**
   * Accepts the legacy sessions.json path (callers unchanged); the database
   * lives beside it as sessions.db.
   */
  constructor(filePath: string) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(dir, "sessions.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      key TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      provider TEXT NOT NULL,
      surface TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      lastUsedAt TEXT NOT NULL,
      turns INTEGER NOT NULL DEFAULT 0
    )`);
    this.migrateLegacyJson(filePath);
  }

  /** One-time import of the pre-SQL sessions.json, then park it so this never re-runs. */
  private migrateLegacyJson(filePath: string): void {
    let legacy: Record<string, SessionRecord>;
    try { legacy = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, SessionRecord>; }
    catch { return; }
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO sessions (key, id, provider, surface, createdAt, lastUsedAt, turns) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.db.transaction(() => {
      for (const [k, record] of Object.entries(legacy)) {
        if (!record?.id) continue;
        insert.run(k, record.id, record.provider, record.surface, record.createdAt, record.lastUsedAt, record.turns ?? 0);
      }
    })();
    try { fs.renameSync(filePath, `${filePath}.migrated`); } catch { /* best effort */ }
  }

  /**
   * Returns the session to use for this turn: `fresh: true` means the caller
   * must CREATE the session this turn (pass the id as the new session id);
   * `fresh: false` means resume the existing id.
   */
  acquire(surface: string, provider: ProviderName, now = new Date()): { id: string; fresh: boolean } {
    const k = key(surface, provider);
    // .immediate takes the write lock up front (audit 2026-08-09 L4): a deferred
    // read→write upgrade under cross-process contention fails with
    // SQLITE_BUSY_SNAPSHOT instead of waiting on busy_timeout, killing the turn.
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM sessions WHERE key = ?").get(k) as SessionRecord | undefined;
      const stale = !existing
        || now.getTime() - new Date(existing.lastUsedAt).getTime() > SESSION_STALE_MS
        || existing.turns >= SESSION_MAX_TURNS;
      if (!stale && existing) return { id: existing.id, fresh: false };
      const id = randomUUID();
      this.db.prepare(
        "INSERT INTO sessions (key, id, provider, surface, createdAt, lastUsedAt, turns) VALUES (?, ?, ?, ?, ?, ?, 0) " +
        "ON CONFLICT(key) DO UPDATE SET id = excluded.id, createdAt = excluded.createdAt, lastUsedAt = excluded.lastUsedAt, turns = 0",
      ).run(k, id, provider, surface, now.toISOString(), now.toISOString());
      return { id, fresh: true };
    }).immediate();
  }

  /** Call after a successful turn so staleness/turn accounting stays honest. */
  markUsed(surface: string, provider: ProviderName, now = new Date()): void {
    this.db.prepare("UPDATE sessions SET lastUsedAt = ?, turns = turns + 1 WHERE key = ?")
      .run(now.toISOString(), key(surface, provider));
  }

  /** Codex mints its own session/thread id on create — swap ours for the real one. */
  updateId(surface: string, provider: ProviderName, realId: string): void {
    this.db.prepare("UPDATE sessions SET id = ? WHERE key = ?").run(realId, key(surface, provider));
  }

  /** A failed resume (session evicted provider-side) must not poison later turns. */
  reset(surface: string, provider?: ProviderName): void {
    if (provider) this.db.prepare("DELETE FROM sessions WHERE key = ?").run(key(surface, provider));
    else this.db.prepare("DELETE FROM sessions WHERE surface = ?").run(surface);
  }

  list(): SessionRecord[] {
    return this.db.prepare("SELECT id, provider, surface, createdAt, lastUsedAt, turns FROM sessions").all() as SessionRecord[];
  }

  close(): void { this.db.close(); }
}

/**
 * Provider-specific CLI arg fragments for create-vs-resume. Kept here so the
 * runner's arg builders stay declarative.
 * - claude: `--session-id <id>` on create, `--resume <id>` on later turns.
 * - codex: `exec` supports `resume <id>`; on create we pass `--session-id`-less
 *   ephemeral is DROPPED (sessions imply persistence) and we read the id from
 *   the stream's session_configured event — callers pass ours as a correlation
 *   fallback only. Codex resume subcommand: `codex exec resume <id> <prompt>`.
 */
export function sessionArgs(provider: ProviderName, session: { id: string; fresh: boolean }): {
  claudeArgs: string[]; codexSubcommand: string[];
} {
  if (provider === "claude") {
    return {
      claudeArgs: session.fresh ? ["--session-id", session.id] : ["--resume", session.id],
      codexSubcommand: [],
    };
  }
  return {
    claudeArgs: [],
    codexSubcommand: session.fresh ? [] : ["resume", session.id],
  };
}
