import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { loadConfig } from "../src/config.ts";
import { setActiveProfile } from "../src/profile.ts";
import { ActivityLog } from "../src/activity.ts";
import { CommerceService, type CatalogueRagPort } from "../src/commerce/service.ts";
import type { CatalogueProduct } from "../src/commerce/types.ts";

async function fixture(): Promise<{ root: string; service: CommerceService; csv: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kelly-commerce-"));
  setActiveProfile("kelly"); const config = loadConfig(root); const activity = new ActivityLog(config.activityPath); await activity.init();
  const csv = path.join(root, "catalogue.csv");
  await fs.writeFile(csv, "SKU,Brand,Name,Category,Unit,Price,GST\n0007,Acme,MCB 16A,MCB,piece,100,18\n0008,Beta,MCB 16A,MCB,piece,120,18\n");
  const rag: CatalogueRagPort = {
    index: async (products: CatalogueProduct[]) => products.length,
    search: async () => [],
    close: () => undefined,
  };
  return { root, service: new CommerceService(config, activity, rag), csv };
}

test("catalogue requires review before products can be quoted", async () => {
  const { service, csv } = await fixture();
  try {
    const imported = await service.importCatalogue(csv) as { documentId: string; imported: number };
    assert.equal(imported.imported, 2);
    assert.equal(((await service.search("0007")) as { products: unknown[] }).products.length, 0);
    await service.publish(imported.documentId);
    assert.equal(((await service.search("0007")) as { products: unknown[] }).products.length, 1);
    const quote = service.createQuote({ brand: "Acme", lines: [{ sku: "0007", quantity: 10, lineDiscountBasisPoints: 1000 }] });
    assert.equal(quote.complete, true); assert.equal(quote.totalPaise, 106_200);
  } finally { service.close(); }
});

test("duplicate source import is idempotent and missing brand stays incomplete", async () => {
  const { service, csv } = await fixture();
  try {
    const first = await service.importCatalogue(csv) as { documentId: string };
    assert.equal((await service.importCatalogue(csv) as { duplicate: boolean }).duplicate, true);
    await service.publish(first.documentId);
    const quote = service.createQuote({ brand: "Missing", lines: [{ sku: "0007", quantity: 1 }] });
    assert.equal(quote.complete, false); assert.equal(quote.totalPaise, 0);
  } finally { service.close(); }
});

test("workbook navigation, versioned edit and quote export work", async () => {
  const { root, service, csv } = await fixture();
  try {
    const info = await service.inspectWorkbook(csv) as { sheets: unknown[] }; assert.equal(info.sheets.length, 1);
    const matches = await service.searchWorkbook(csv, "0007") as { matches: unknown[] }; assert.equal(matches.matches.length, 1);
    const edited = await service.editWorkbook(csv, [{ sheet: "sheet1", cell: "F2", value: 105 }]) as { outputPath: string };
    assert.notEqual(path.resolve(edited.outputPath), path.resolve(csv)); await fs.access(edited.outputPath); assert.equal((await fs.readFile(csv, "utf8")).includes(",100,"), true);
    const imported = await service.importCatalogue(csv) as { documentId: string }; await service.publish(imported.documentId);
    const quote = service.createQuote({ brand: "Acme", customerName: "Sample Customer", lines: [{ sku: "0007", quantity: 1 }] });
    const output = path.join(root, "quote.xlsx"); await service.exportQuote(quote.id, output); const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(output);
    assert.equal(workbook.getWorksheet("Quotation")?.getCell("H8").value, 118);
  } finally { service.close(); }
});
