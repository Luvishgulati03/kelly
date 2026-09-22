import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import { runCommand } from "../util/command.ts";
import { calculateLine } from "./money.ts";
import { CommerceStore } from "./store.ts";
import { tradePack } from "../trade/index.ts";
import type { CalculatedQuote, CatalogueProductInput, QuoteRequest, SourceKind } from "./types.ts";
import { editWorkbook, exportQuoteWorkbook, extractCatalogueRows, inspectWorkbook, readRange, searchWorkbook, type WorkbookEdit } from "./workbooks.ts";

function addDays(date: Date, days: number): string { const result = new Date(date); result.setUTCDate(result.getUTCDate() + days); return result.toISOString(); }

export class CommerceService {
  readonly store: CommerceStore;
  private rag?: CatalogueRagPort;
  constructor(private readonly config: HenryConfig, private readonly activity: ActivityLog, rag?: CatalogueRagPort) {
    this.store = new CommerceStore(path.join(config.dataDir, "commerce.db"));
    this.rag = rag;
  }

  private async catalogueRag(): Promise<CatalogueRagPort> {
    if (!this.rag) {
      const { CatalogueRag } = await import("./rag.ts");
      this.rag = new CatalogueRag(this.config);
    }
    return this.rag;
  }

  async importCatalogue(filePath: string, options: { sheet?: string } = {}): Promise<unknown> {
    const absolute = path.resolve(filePath); const bytes = await fs.readFile(absolute); const ext = path.extname(absolute).toLowerCase();
    let products: CatalogueProductInput[]; let kind: SourceKind;
    if (ext === ".xlsx" || ext === ".csv") { products = await extractCatalogueRows(absolute, options.sheet, { shopName: this.config.shopName }); kind = ext.slice(1) as SourceKind; }
    else if (ext === ".pdf") { products = await this.extractPdfCandidates(absolute); kind = "pdf"; }
    else throw new Error("Catalogue import supports PDF, XLSX and CSV files");
    if (!products.length) throw new Error("No product rows were detected. Nothing was imported.");
    const sourceDir = path.join(this.config.dataDir, "catalogue", "sources");
    await fs.mkdir(sourceDir, { recursive: true, mode: 0o700 });
    const sourceHash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const storedSource = path.join(sourceDir, `${path.basename(absolute, ext)}-${sourceHash}${ext}`);
    await fs.copyFile(absolute, storedSource, fsConstants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const result = this.store.importProducts(storedSource, kind, bytes, products);
    await this.activity.record("knowledge.indexed", `Catalogue import ${result.duplicate ? "skipped duplicate" : "prepared for review"}`, { ...result, source: path.basename(filePath) });
    return { ...result, status: result.duplicate ? "duplicate" : "pending-review", products: result.imported };
  }

  private async extractPdfCandidates(filePath: string): Promise<CatalogueProductInput[]> {
    const result = await runCommand("pdftotext", ["-layout", filePath, "-"], this.config.rootDir);
    if (result.exitCode !== 0) throw new Error(`PDF extraction failed: ${(result.stderr || "pdftotext is required").trim()}`);
    const products: CatalogueProductInput[] = [];
    const pattern = /^\s*(\S+)\s{2,}(.+?)\s{2,}(\d+(?:\.\d{1,2})?)\s*$/;
    result.stdout.split(/\r?\n/).forEach((line, index) => {
      const match = pattern.exec(line); if (!match) return;
      products.push({ sku: match[1], brand: "REVIEW_REQUIRED", name: match[2].trim(), category: "unclassified", pricePaise: Math.round(Number(match[3]) * 100), sourceLocation: `page-text-line:${index + 1}` });
    });
    return products;
  }

  async publish(documentId: string): Promise<unknown> {
    const publishedProducts = this.store.publish(documentId);
    const indexed = await (await this.catalogueRag()).index(this.store.productsForDocument(documentId).filter((item) => item.status === "published"));
    return { documentId, publishedProducts, indexed };
  }
  async search(query: string, brand?: string, includePending = false): Promise<unknown> {
    const exact = this.store.search(query, brand, includePending);
    return { products: exact, semanticEvidence: query.trim() ? await (await this.catalogueRag()).search(query, brand) : [] };
  }

  /**
   * Small, authoritative prompt block for Kelly's brain. This is deliberately assembled
   * from the published structured store rather than relying on the model to remember to
   * invoke a CLI. Semantic RAG helps discover candidates; prices and evidence always come
   * from the structured rows below.
   */
  async context(query: string, limit = 12): Promise<string> {
    const clean = query.trim();
    const broad = /\b(what|which|show|list|available|catalog(?:ue)?|categories|products|items|stock)\b/i.test(clean)
      && !/\b(sku|brand|model|watt|volt|amp|mm|bulb|fan|wire|cable|switch|socket|chair|desk|kettle|paper|mcb)\b/i.test(clean);
    const candidates = new Map<string, CatalogueProductInput & { id: string; documentId: string; status: "pending" | "published"; importedAt: string }>();
    const add = (items: ReturnType<CommerceStore["search"]>): void => {
      for (const item of items) if (!candidates.has(item.id)) candidates.set(item.id, item);
    };
    if (broad || !clean) add(this.store.search("", undefined, false));
    else {
      add(this.store.search(clean, undefined, false));
      const terms = clean.toLowerCase().match(/[a-z0-9][a-z0-9.-]{1,}/g) ?? [];
      const ignored = new Set(["what", "which", "show", "list", "have", "need", "want", "with", "from", "same", "available", "product", "products", "item", "items", "quotation", "quote", "please"]);
      for (const term of terms.filter((value) => !ignored.has(value)).slice(0, 8)) add(this.store.search(term, undefined, false));
    }
    const products = [...candidates.values()].slice(0, limit);
    if (!products.length) return [
      "--- Published catalogue (AUTHORITATIVE) ---",
      "No matching published products were found. Say that the requested item was not found; do not claim that the whole catalogue is empty unless this was a broad catalogue request.",
    ].join("\n");
    const allPublished = broad ? [...candidates.values()] : [];
    const categories = [...new Set(allPublished.map((item) => item.category))].sort();
    return [
      "--- Published catalogue (AUTHORITATIVE CURRENT DATA) ---",
      "Use only these structured rows for product, SKU, price, tax, unit and source claims. Similar-conversation RAG is secondary and cannot override them.",
      ...(categories.length ? [`Available categories: ${categories.join(", ")}.`] : []),
      ...products.map((item) => `- ${item.brand} | ${item.sku} | ${item.name} | category ${item.category} | unit ${item.unit || "unit"} | ₹${(item.pricePaise / 100).toFixed(2)} before configured tax | GST ${(item.gstBasisPoints || 0) / 100}% | source ${item.sourceLocation}`),
      allPublished.length > products.length ? `Showing ${products.length} of ${allPublished.length} published products.` : `Matched ${products.length} published product${products.length === 1 ? "" : "s"}.`,
    ].join("\n");
  }
  documents(): unknown { return this.store.listDocuments(); }
  async catalogueTemplate(outPath?: string): Promise<string> {
    const { generateCatalogueTemplate } = await import("./template.ts");
    return generateCatalogueTemplate(this.config.trade, outPath, this.config.rootDir);
  }

  createQuote(request: QuoteRequest, save = true): CalculatedQuote {
    const pack = tradePack(this.config.trade);
    let brand = request.brand?.trim();
    if (!brand) {
      if (pack.brandRequired) throw new Error("A brand is required");
      brand = this.config.shopName?.trim() || "house";
    }
    if (!request.lines?.length) throw new Error("At least one requirement line is required");
    const unresolved = []; const lines = [];
    for (const requestLine of request.lines) {
      const query = requestLine.sku || requestLine.query || "";
      const candidates = this.store.search(query, brand).filter((item) => requestLine.sku ? item.sku.toLowerCase() === requestLine.sku.toLowerCase() : true);
      if (candidates.length !== 1) { unresolved.push(requestLine); continue; }
      lines.push(calculateLine(candidates[0], requestLine.quantity, requestLine.lineDiscountBasisPoints, request.basketDiscountBasisPoints));
    }
    const now = new Date(); const quote: CalculatedQuote = {
      id: randomUUID(), version: 1, brand, customerName: request.customerName,
      complete: unresolved.length === 0, unresolved, lines,
      subtotalPaise: lines.reduce((sum, line) => sum + line.grossPaise, 0),
      discountPaise: lines.reduce((sum, line) => sum + line.discountPaise, 0),
      taxPaise: lines.reduce((sum, line) => sum + line.taxPaise, 0),
      totalPaise: lines.reduce((sum, line) => sum + line.totalPaise, 0),
      createdAt: now.toISOString(), validUntil: addDays(now, request.validDays ?? 7),
    };
    if (save) this.store.saveQuote(quote);
    return quote;
  }

  compare(request: Omit<QuoteRequest, "brand">, brands: string[]): CalculatedQuote[] {
    if (brands.length < 2) throw new Error("Provide at least two brands to compare");
    return brands.map((brand) => this.createQuote({ ...request, brand }, false));
  }

  quote(id: string): CalculatedQuote { const quote = this.store.quote(id); if (!quote) throw new Error(`Quote not found: ${id}`); return quote; }
  inspectWorkbook(filePath: string): Promise<unknown> { return inspectWorkbook(filePath); }
  readWorkbook(filePath: string, sheet: string, range: string): Promise<unknown> { return readRange(filePath, sheet, range); }
  searchWorkbook(filePath: string, query: string): Promise<unknown> { return searchWorkbook(filePath, query); }
  editWorkbook(filePath: string, edits: WorkbookEdit[], outputPath?: string, expectedSha256?: string): Promise<unknown> { return editWorkbook(filePath, edits, outputPath, expectedSha256); }
  exportQuote(id: string, outputPath?: string): Promise<string> {
    const quote = this.quote(id); if (!quote.complete) throw new Error("An incomplete quotation cannot be exported as final");
    const selected = outputPath || path.join(this.config.dataDir, "quotes", `${id}.xlsx`); return exportQuoteWorkbook(quote, selected);
  }
  close(): void { this.store.close(); this.rag?.close(); }
}

export interface CatalogueRagPort {
  index(products: import("./types.ts").CatalogueProduct[]): Promise<number>;
  search(query: string, brand?: string, k?: number): Promise<unknown[]>;
  close(): void;
}
