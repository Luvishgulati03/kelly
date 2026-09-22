import Database from "better-sqlite3";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { sniffImageMime } from "../dashboard/attachments.ts";

/**
 * The boutique design gallery store. A SQLite index (data/designs.db) plus the image
 * bytes themselves on disk (data/designs/<id>.<ext>) — same split as the commerce store's
 * structured rows vs. supplier source files. Only meaningful for a trade pack that declares
 * gallery categories (boutique); electrical carries an always-empty instance.
 */

export const MAX_DESIGN_BYTES = 8 * 1024 * 1024;

const ID_PATTERN = /^dsg_[0-9a-f]{16}$/;

export interface DesignRecord {
  id: string;
  category: string;
  tags: string[];
  colours: string[];
  fabric: string;
  occasion: string;
  priceBand: string;
  caption: string;
  addedAt: string;
  shownCount: number;
  status: "active" | "hidden";
  ext: string;
  bytes: number;
}

export interface DesignInput {
  bytes: Buffer;
  category: string;
  tags?: string[];
  colours?: string[];
  fabric?: string;
  occasion?: string;
  priceBand?: string;
  caption?: string;
}

export interface DesignFilter {
  category?: string;
  tags?: string[];
  text?: string;
  latest?: boolean;
  trending?: boolean;
  limit?: number;
  offset?: number;
}

export type AddResult = { design: DesignRecord; duplicate: boolean };

function row2record(row: Record<string, unknown>): DesignRecord {
  return {
    id: String(row.id),
    category: String(row.category),
    tags: JSON.parse(String(row.tags || "[]")) as string[],
    colours: JSON.parse(String(row.colours || "[]")) as string[],
    fabric: String(row.fabric || ""),
    occasion: String(row.occasion || ""),
    priceBand: String(row.price_band || ""),
    caption: String(row.caption || ""),
    addedAt: String(row.added_at),
    shownCount: Number(row.shown_count || 0),
    status: row.status === "hidden" ? "hidden" : "active",
    ext: String(row.ext),
    bytes: Number(row.bytes || 0),
  };
}

const LATEST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export class DesignStore {
  private readonly db: Database.Database;
  readonly filesDir: string;

  constructor(readonly dataDir: string, private readonly categories: string[], private readonly validTags: string[]) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.filesDir = path.join(dataDir, "designs");
    fs.mkdirSync(this.filesDir, { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(dataDir, "designs.db"));
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS designs (
        id TEXT PRIMARY KEY, category TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
        colours TEXT NOT NULL DEFAULT '[]', fabric TEXT NOT NULL DEFAULT '', occasion TEXT NOT NULL DEFAULT '',
        price_band TEXT NOT NULL DEFAULT '', caption TEXT NOT NULL DEFAULT '', added_at TEXT NOT NULL,
        shown_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','hidden')),
        ext TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS designs_lookup ON designs(status, category, added_at);
    `);
  }

  private validateCategory(category: string): string {
    const clean = category.trim().toLowerCase();
    if (!this.categories.includes(clean)) {
      throw new Error(`Unknown design category "${category}". Valid categories: ${this.categories.join(", ")}.`);
    }
    return clean;
  }

  private validateTags(tags: string[]): string[] {
    const clean = [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
    for (const tag of clean) {
      if (!this.validTags.includes(tag)) {
        throw new Error(`Unknown design tag "${tag}". Valid tags: ${this.validTags.join(", ")}.`);
      }
    }
    return clean;
  }

  add(input: DesignInput): AddResult {
    if (!input.bytes.length) throw new Error("Design image is empty.");
    if (input.bytes.length > MAX_DESIGN_BYTES) throw new Error(`Design image is too large (max ${Math.round(MAX_DESIGN_BYTES / (1024 * 1024))}MB).`);
    const mime = sniffImageMime(input.bytes);
    if (!mime) throw new Error("Only images are accepted (PNG, JPEG, WebP, GIF).");
    const ext = mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "gif";
    const category = this.validateCategory(input.category);
    const tags = this.validateTags(input.tags ?? []);
    const sha256 = crypto.createHash("sha256").update(input.bytes).digest("hex");
    const existing = this.db.prepare("SELECT id FROM designs WHERE sha256 = ?").get(sha256) as { id: string } | undefined;
    if (existing) return { design: this.get(existing.id) as DesignRecord, duplicate: true };
    const id = `dsg_${crypto.randomBytes(8).toString("hex")}`;
    const addedAt = new Date().toISOString();
    fs.writeFileSync(path.join(this.filesDir, `${id}.${ext}`), input.bytes, { mode: 0o600 });
    this.db.prepare(`INSERT INTO designs (id,category,tags,colours,fabric,occasion,price_band,caption,added_at,shown_count,status,ext,bytes,sha256)
      VALUES (?,?,?,?,?,?,?,?,?,0,'active',?,?,?)`).run(
      id, category, JSON.stringify(tags), JSON.stringify(input.colours ?? []), input.fabric ?? "", input.occasion ?? "",
      input.priceBand ?? "", input.caption ?? "", addedAt, ext, input.bytes.length, sha256,
    );
    return { design: this.get(id) as DesignRecord, duplicate: false };
  }

  get(id: string): DesignRecord | undefined {
    if (!ID_PATTERN.test(id)) return undefined;
    const row = this.db.prepare("SELECT * FROM designs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? row2record(row) : undefined;
  }

  imagePath(id: string): string | undefined {
    const record = this.get(id);
    if (!record) return undefined;
    return path.join(this.filesDir, `${id}.${record.ext}`);
  }

  update(id: string, patch: { category?: string; tags?: string[]; colours?: string[]; fabric?: string; occasion?: string; priceBand?: string; caption?: string }): DesignRecord {
    const existing = this.get(id);
    if (!existing) throw new Error(`Design not found: ${id}`);
    const category = patch.category !== undefined ? this.validateCategory(patch.category) : existing.category;
    const tags = patch.tags !== undefined ? this.validateTags(patch.tags) : existing.tags;
    const colours = patch.colours ?? existing.colours;
    this.db.prepare(`UPDATE designs SET category=?, tags=?, colours=?, fabric=?, occasion=?, price_band=?, caption=? WHERE id=?`).run(
      category, JSON.stringify(tags), JSON.stringify(colours),
      patch.fabric ?? existing.fabric, patch.occasion ?? existing.occasion,
      patch.priceBand ?? existing.priceBand, patch.caption ?? existing.caption, id,
    );
    return this.get(id) as DesignRecord;
  }

  hide(id: string): DesignRecord {
    if (!this.get(id)) throw new Error(`Design not found: ${id}`);
    this.db.prepare("UPDATE designs SET status='hidden' WHERE id=?").run(id);
    return this.get(id) as DesignRecord;
  }

  list(filter: DesignFilter = {}): DesignRecord[] {
    const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
    const offset = Math.max(0, filter.offset ?? 0);
    if (filter.trending) {
      // Union: tagged "trending" OR top by shown_count, ordered by shown_count desc, added_at desc.
      const rows = this.db.prepare(`
        SELECT * FROM designs WHERE status='active'
        AND (? IS NULL OR category = ?)
        AND (instr(lower(tags), '"trending"') > 0 OR shown_count > 0)
        ORDER BY shown_count DESC, added_at DESC LIMIT ? OFFSET ?
      `).all(filter.category ?? null, filter.category ?? null, limit, offset) as Record<string, unknown>[];
      return this.applyTagAndTextFilter(rows.map(row2record), filter);
    }
    const clauses: string[] = ["status='active'"];
    const params: unknown[] = [];
    if (filter.category) { clauses.push("category = ?"); params.push(filter.category); }
    if (filter.latest) { clauses.push("added_at >= ?"); params.push(new Date(Date.now() - LATEST_WINDOW_MS).toISOString()); }
    if (filter.text) {
      clauses.push("(lower(caption) LIKE ? OR lower(colours) LIKE ? OR lower(fabric) LIKE ? OR lower(occasion) LIKE ?)");
      const needle = `%${filter.text.toLowerCase()}%`;
      params.push(needle, needle, needle, needle);
    }
    const sql = `SELECT * FROM designs WHERE ${clauses.join(" AND ")} ORDER BY added_at DESC LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params, limit, offset) as Record<string, unknown>[];
    return this.applyTagAndTextFilter(rows.map(row2record), filter);
  }

  private applyTagAndTextFilter(records: DesignRecord[], filter: DesignFilter): DesignRecord[] {
    let out = records;
    if (filter.tags?.length) {
      const wanted = filter.tags.map((tag) => tag.toLowerCase());
      out = out.filter((record) => wanted.every((tag) => record.tags.includes(tag)));
    }
    return out;
  }

  markShown(ids: string[]): void {
    const stmt = this.db.prepare("UPDATE designs SET shown_count = shown_count + 1 WHERE id = ?");
    const tx = this.db.transaction((values: string[]) => { for (const id of values) stmt.run(id); });
    tx(ids.filter((id) => ID_PATTERN.test(id)));
  }

  stats(): { categories: Record<string, number>; tags: Record<string, number>; total: number; hidden: number } {
    const rows = this.db.prepare("SELECT category, tags, status FROM designs").all() as { category: string; tags: string; status: string }[];
    const categories: Record<string, number> = {};
    const tags: Record<string, number> = {};
    let hidden = 0;
    for (const row of rows) {
      if (row.status === "hidden") { hidden += 1; continue; }
      categories[row.category] = (categories[row.category] || 0) + 1;
      for (const tag of JSON.parse(row.tags || "[]") as string[]) tags[tag] = (tags[tag] || 0) + 1;
    }
    return { categories, tags, total: rows.length, hidden };
  }

  close(): void { this.db.close(); }
}

/** Non-recursive: every png/jpg/jpeg/webp file directly inside a folder. */
export async function imageFilesInFolder(folder: string): Promise<string[]> {
  const entries = await fsp.readdir(folder, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
    .map((entry) => path.join(folder, entry.name))
    .sort();
}
