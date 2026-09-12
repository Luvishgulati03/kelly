import type ExcelJS from "exceljs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { CatalogueProductInput } from "./types.ts";

function assertWorkbookPath(filePath: string): "xlsx" | "csv" {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".xls" || ext === ".xlsm") throw new Error(`${ext} is not supported. Save a macro-free .xlsx copy first.`);
  if (ext !== ".xlsx" && ext !== ".csv") throw new Error("Only .xlsx and .csv workbooks are supported");
  return ext.slice(1) as "xlsx" | "csv";
}

async function loadWorkbook(filePath: string): Promise<ExcelJS.Workbook> {
  const kind = assertWorkbookPath(filePath);
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  // ExcelJS otherwise coerces number-looking identifiers such as 0007 to 7.
  // Supplier SKUs are identifiers, so preserve every CSV field as source text.
  if (kind === "csv") await workbook.csv.readFile(filePath, { map: (value) => value });
  else await workbook.xlsx.readFile(filePath);
  return workbook;
}

function displayed(value: ExcelJS.CellValue): unknown {
  if (value && typeof value === "object" && "result" in value) return value.result;
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}

export async function inspectWorkbook(filePath: string): Promise<unknown> {
  const workbook = await loadWorkbook(filePath);
  return { filePath, sheets: workbook.worksheets.map((sheet) => ({ name: sheet.name, rows: sheet.rowCount, columns: sheet.columnCount })) };
}

export async function readRange(filePath: string, sheetName: string, range: string): Promise<unknown> {
  const workbook = await loadWorkbook(filePath);
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new Error(`Sheet not found: ${sheetName}`);
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(range);
  if (!match) throw new Error("Range must look like A1:F20");
  const start = sheet.getCell(`${match[1]}${match[2]}`); const end = sheet.getCell(`${match[3]}${match[4]}`);
  const values: unknown[][] = [];
  for (let row = start.row; row <= end.row; row++) {
    const current: unknown[] = [];
    for (let col = start.col; col <= end.col; col++) current.push(displayed(sheet.getCell(row, col).value));
    values.push(current);
  }
  return { sheet: sheetName, range, values };
}

export async function searchWorkbook(filePath: string, query: string): Promise<unknown> {
  const workbook = await loadWorkbook(filePath); const needle = query.toLowerCase(); const matches: unknown[] = [];
  for (const sheet of workbook.worksheets) sheet.eachRow((row) => row.eachCell((cell) => {
    const value = displayed(cell.value);
    if (String(value ?? "").toLowerCase().includes(needle) && matches.length < 100) matches.push({ sheet: sheet.name, cell: cell.address, value });
  }));
  return { query, matches };
}

export interface WorkbookEdit { sheet: string; cell: string; value: string | number | boolean | null }

export async function editWorkbook(filePath: string, edits: WorkbookEdit[], outputPath?: string, expectedSha256?: string): Promise<unknown> {
  assertWorkbookPath(filePath);
  const original = await fs.readFile(filePath); const sha256 = createHash("sha256").update(original).digest("hex");
  if (expectedSha256 && expectedSha256 !== sha256) throw new Error("Workbook changed since preview; inspect it again before editing");
  const workbook = await loadWorkbook(filePath); const changes: unknown[] = [];
  for (const edit of edits) {
    const sheet = workbook.getWorksheet(edit.sheet); if (!sheet) throw new Error(`Sheet not found: ${edit.sheet}`);
    if (!/^[A-Z]+[1-9]\d*$/i.test(edit.cell)) throw new Error(`Invalid cell: ${edit.cell}`);
    const cell = sheet.getCell(edit.cell); changes.push({ ...edit, previous: displayed(cell.value) }); cell.value = edit.value;
  }
  const parsed = path.parse(filePath);
  const selected = outputPath || path.join(parsed.dir, `${parsed.name}.kelly-${Date.now()}.xlsx`);
  if (path.resolve(selected) === path.resolve(filePath)) throw new Error("Kelly does not overwrite the original workbook");
  await workbook.xlsx.writeFile(selected);
  return { originalSha256: sha256, outputPath: selected, changes };
}

function normalizeHeader(value: unknown): string { return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, ""); }
const HEADERS: Record<string, string[]> = {
  sku: ["sku", "itemcode", "productcode", "catalogueno", "catno"], brand: ["brand", "make", "company"],
  name: ["name", "product", "description", "itemdescription"], category: ["category", "group", "productcategory"],
  specification: ["specification", "spec", "rating"], unit: ["unit", "uom"], packSize: ["packsize", "pack", "qtyperpack"],
  price: ["price", "mrp", "rate", "unitprice"], gst: ["gst", "gstrate", "tax"], taxInclusive: ["taxinclusive", "inclusive"],
};

export async function extractCatalogueRows(filePath: string, sheetName?: string): Promise<CatalogueProductInput[]> {
  const workbook = await loadWorkbook(filePath); const sheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];
  if (!sheet) throw new Error("Workbook has no readable sheet");
  const indexes: Record<string, number> = {};
  sheet.getRow(1).eachCell((cell, col) => {
    const normalized = normalizeHeader(displayed(cell.value));
    for (const [field, aliases] of Object.entries(HEADERS)) if (aliases.includes(normalized)) indexes[field] = col;
  });
  for (const required of ["sku", "brand", "name", "price"]) if (!indexes[required]) throw new Error(`Missing required catalogue column: ${required}`);
  const rows: CatalogueProductInput[] = [];
  for (let rowNo = 2; rowNo <= sheet.rowCount; rowNo++) {
    const row = sheet.getRow(rowNo); const sku = String(displayed(row.getCell(indexes.sku).value) ?? "").trim(); if (!sku) continue;
    const price = Number(displayed(row.getCell(indexes.price).value)); if (!Number.isFinite(price) || price < 0) throw new Error(`Invalid price at ${sheet.name}!${row.getCell(indexes.price).address}`);
    const gstValue = indexes.gst ? Number(displayed(row.getCell(indexes.gst).value) || 0) : 0;
    rows.push({ sku, brand: String(displayed(row.getCell(indexes.brand).value) ?? "").trim(), name: String(displayed(row.getCell(indexes.name).value) ?? "").trim(),
      category: indexes.category ? String(displayed(row.getCell(indexes.category).value) ?? "general") : "general",
      specification: indexes.specification ? String(displayed(row.getCell(indexes.specification).value) ?? "") : "",
      unit: indexes.unit ? String(displayed(row.getCell(indexes.unit).value) ?? "unit") : "unit",
      packSize: indexes.packSize ? Number(displayed(row.getCell(indexes.packSize).value) || 1) : 1,
      pricePaise: Math.round(price * 100), gstBasisPoints: Math.round(gstValue * 100),
      taxInclusive: indexes.taxInclusive ? /^(yes|true|1|inclusive)$/i.test(String(displayed(row.getCell(indexes.taxInclusive).value))) : false,
      sourceLocation: `${sheet.name}!${rowNo}:${rowNo}` });
  }
  return rows;
}

export async function exportQuoteWorkbook(quote: { id: string; customerName?: string; brand: string; lines: Array<{ sku: string; name: string; quantityMilli: number; unit: string; unitPricePaise: number; taxablePaise: number; taxPaise: number; totalPaise: number }>; totalPaise: number }, outputPath: string): Promise<string> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet("Quotation");
  sheet.addRow(["KELLY QUOTATION"]); sheet.mergeCells("A1:H1"); sheet.getCell("A1").font = { bold: true, size: 16 };
  sheet.addRow(["Quote ID", quote.id]); sheet.addRow(["Customer", quote.customerName || "Walk-in customer"]); sheet.addRow(["Brand", quote.brand]); sheet.addRow([]);
  sheet.addRow(["SKU", "Item", "Quantity", "Unit", "Unit price", "Taxable", "GST", "Total"]);
  for (const line of quote.lines) sheet.addRow([line.sku, line.name, line.quantityMilli / 1000, line.unit, line.unitPricePaise / 100, line.taxablePaise / 100, line.taxPaise / 100, line.totalPaise / 100]);
  sheet.addRow(["", "", "", "", "", "", "Grand total", quote.totalPaise / 100]);
  sheet.getRow(6).font = { bold: true }; sheet.getColumn(2).width = 36;
  for (const col of [5, 6, 7, 8]) sheet.getColumn(col).numFmt = '₹#,##0.00';
  await fs.mkdir(path.dirname(outputPath), { recursive: true }); await workbook.xlsx.writeFile(outputPath); return outputPath;
}
