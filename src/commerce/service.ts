import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import { runCommand } from "../util/command.ts";
import { calculateLine } from "./money.ts";
import { CommerceStore } from "./store.ts";
import { CatalogueRag } from "./rag.ts";
import type { CalculatedQuote, CatalogueProductInput, QuoteRequest, SourceKind } from "./types.ts";
import { editWorkbook, exportQuoteWorkbook, extractCatalogueRows, inspectWorkbook, readRange, searchWorkbook, type WorkbookEdit } from "./workbooks.ts";

function addDays(date: Date, days: number): string { const result = new Date(date); result.setUTCDate(result.getUTCDate() + days); return result.toISOString(); }

export class CommerceService {
  readonly store: CommerceStore;
  readonly rag: CatalogueRag;
  constructor(private readonly config: HenryConfig, private readonly activity: ActivityLog, rag?: CatalogueRag) {
    this.store = new CommerceStore(path.join(config.dataDir, "commerce.db"));
    this.rag = rag ?? new CatalogueRag(config);
  }

  async importCatalogue(filePath: string, options: { sheet?: string } = {}): Promise<unknown> {
    const absolute = path.resolve(filePath); const bytes = await fs.readFile(absolute); const ext = path.extname(absolute).toLowerCase();
    let products: CatalogueProductInput[]; let kind: SourceKind;
    if (ext === ".xlsx" || ext === ".csv") { products = await extractCatalogueRows(absolute, options.sheet); kind = ext.slice(1) as SourceKind; }
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
    const indexed = await this.rag.index(this.store.productsForDocument(documentId).filter((item) => item.status === "published"));
    return { documentId, publishedProducts, indexed };
  }
  async search(query: string, brand?: string, includePending = false): Promise<unknown> {
    const exact = this.store.search(query, brand, includePending);
    return { products: exact, semanticEvidence: query.trim() ? await this.rag.search(query, brand) : [] };
  }
  documents(): unknown { return this.store.listDocuments(); }

  createQuote(request: QuoteRequest, save = true): CalculatedQuote {
    if (!request.brand?.trim()) throw new Error("A brand is required");
    if (!request.lines?.length) throw new Error("At least one requirement line is required");
    const unresolved = []; const lines = [];
    for (const requestLine of request.lines) {
      const query = requestLine.sku || requestLine.query || "";
      const candidates = this.store.search(query, request.brand).filter((item) => requestLine.sku ? item.sku.toLowerCase() === requestLine.sku.toLowerCase() : true);
      if (candidates.length !== 1) { unresolved.push(requestLine); continue; }
      lines.push(calculateLine(candidates[0], requestLine.quantity, requestLine.lineDiscountBasisPoints, request.basketDiscountBasisPoints));
    }
    const now = new Date(); const quote: CalculatedQuote = {
      id: randomUUID(), version: 1, brand: request.brand, customerName: request.customerName,
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
  close(): void { this.store.close(); this.rag.close(); }
}
