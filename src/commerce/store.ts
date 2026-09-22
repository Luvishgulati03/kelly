import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { CalculatedQuote, CatalogueProduct, CatalogueProductInput, SourceKind } from "./types.ts";

export class CommerceStore {
  private readonly db: Database.Database;
  constructor(readonly dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS catalogue_documents (
        id TEXT PRIMARY KEY, source_path TEXT NOT NULL, source_kind TEXT NOT NULL,
        sha256 TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('pending','published')),
        imported_at TEXT NOT NULL, published_at TEXT
      );
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES catalogue_documents(id),
        sku TEXT NOT NULL, brand TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
        specification TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT 'unit', pack_size INTEGER NOT NULL DEFAULT 1,
        price_paise INTEGER NOT NULL CHECK(price_paise >= 0), gst_basis_points INTEGER NOT NULL DEFAULT 0,
        tax_inclusive INTEGER NOT NULL DEFAULT 0, source_location TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','published')), imported_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS products_lookup ON products(status, brand, sku, category);
      CREATE TABLE IF NOT EXISTS quotes (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL, brand TEXT NOT NULL, customer_name TEXT,
        complete INTEGER NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, valid_until TEXT NOT NULL
      );
    `);
  }

  importProducts(sourcePath: string, sourceKind: SourceKind, bytes: Buffer, products: CatalogueProductInput[]): { documentId: string; imported: number; duplicate: boolean } {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = this.db.prepare("SELECT id FROM catalogue_documents WHERE sha256 = ?").get(sha256) as { id: string } | undefined;
    if (existing) return { documentId: existing.id, imported: 0, duplicate: true };
    const documentId = randomUUID();
    const importedAt = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db.prepare("INSERT INTO catalogue_documents (id,source_path,source_kind,sha256,status,imported_at) VALUES (?,?,?,?,?,?)")
        .run(documentId, sourcePath, sourceKind, sha256, "pending", importedAt);
      const insert = this.db.prepare(`INSERT INTO products
        (id,document_id,sku,brand,name,category,specification,unit,pack_size,price_paise,gst_basis_points,tax_inclusive,source_location,status,imported_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const item of products) insert.run(
        randomUUID(), documentId, item.sku, item.brand, item.name, item.category,
        item.specification || "", item.unit || "unit", item.packSize || 1, item.pricePaise,
        item.gstBasisPoints || 0, item.taxInclusive ? 1 : 0, item.sourceLocation, "pending", importedAt,
      );
    });
    tx();
    return { documentId, imported: products.length, duplicate: false };
  }

  publish(documentId: string): number {
    const tx = this.db.transaction(() => {
      const document = this.db.prepare("UPDATE catalogue_documents SET status='published', published_at=? WHERE id=? AND status='pending'")
        .run(new Date().toISOString(), documentId);
      if (!document.changes) throw new Error(`Pending catalogue document not found: ${documentId}`);
      return this.db.prepare("UPDATE products SET status='published' WHERE document_id=?").run(documentId).changes;
    });
    return tx();
  }

  listDocuments(): unknown[] {
    return this.db.prepare("SELECT id,source_path AS sourcePath,source_kind AS sourceKind,sha256,status,imported_at AS importedAt,published_at AS publishedAt FROM catalogue_documents ORDER BY imported_at DESC").all();
  }

  productsForDocument(documentId: string): CatalogueProduct[] {
    return this.search("", undefined, true).filter((item) => item.documentId === documentId);
  }

  search(query: string, brand?: string, includePending = false): CatalogueProduct[] {
    const needle = `%${query.toLowerCase()}%`;
    const rows = this.db.prepare(`SELECT p.* FROM products p WHERE (? OR p.status='published')
      AND (? IS NULL OR lower(p.brand)=lower(?))
      AND (lower(p.sku)=lower(?) OR lower(p.sku) LIKE ? OR lower(p.brand) LIKE ? OR lower(p.name) LIKE ? OR lower(p.category) LIKE ? OR lower(p.specification) LIKE ?)
      ORDER BY CASE WHEN lower(p.sku)=lower(?) THEN 0 ELSE 1 END, p.brand, p.name LIMIT 25`)
      .all(includePending ? 1 : 0, brand ?? null, brand ?? null, query, needle, needle, needle, needle, needle, query) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), documentId: String(row.document_id), sku: String(row.sku), brand: String(row.brand),
      name: String(row.name), category: String(row.category), specification: String(row.specification),
      unit: String(row.unit), packSize: Number(row.pack_size), pricePaise: Number(row.price_paise),
      gstBasisPoints: Number(row.gst_basis_points), taxInclusive: Boolean(row.tax_inclusive),
      sourceLocation: String(row.source_location), status: row.status as "pending" | "published", importedAt: String(row.imported_at),
    }));
  }

  saveQuote(quote: CalculatedQuote): void {
    this.db.prepare("INSERT INTO quotes (id,version,brand,customer_name,complete,payload_json,created_at,valid_until) VALUES (?,?,?,?,?,?,?,?)")
      .run(quote.id, quote.version, quote.brand, quote.customerName ?? null, quote.complete ? 1 : 0, JSON.stringify(quote), quote.createdAt, quote.validUntil);
  }

  quote(id: string): CalculatedQuote | undefined {
    const row = this.db.prepare("SELECT payload_json FROM quotes WHERE id=? ORDER BY version DESC LIMIT 1").get(id) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as CalculatedQuote : undefined;
  }

  close(): void { this.db.close(); }
}
