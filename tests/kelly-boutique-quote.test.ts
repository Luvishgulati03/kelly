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
import { generateCatalogueTemplate } from "../src/commerce/template.ts";
import type { CatalogueProduct } from "../src/commerce/types.ts";

const noopRag: CatalogueRagPort = { index: async (products: CatalogueProduct[]) => products.length, search: async () => [], close: () => undefined };

async function withTrade<T>(trade: "boutique" | "electrical", run: (config: ReturnType<typeof loadConfig>, root: string) => Promise<T>): Promise<T> {
  const savedTrade = process.env.KELLY_TRADE;
  const savedShop = process.env.KELLY_SHOP_NAME;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `kelly-${trade}-`));
  setActiveProfile("kelly");
  process.env.KELLY_TRADE = trade;
  if (trade === "boutique") process.env.KELLY_SHOP_NAME = "She Fashion House";
  try {
    const config = loadConfig(root);
    return await run(config, root);
  } finally {
    if (savedTrade === undefined) delete process.env.KELLY_TRADE; else process.env.KELLY_TRADE = savedTrade;
    if (savedShop === undefined) delete process.env.KELLY_SHOP_NAME; else process.env.KELLY_SHOP_NAME = savedShop;
  }
}

test("catalogue template: boutique rate card has the expected headers and 14 rows", async () => {
  await withTrade("boutique", async (config, root) => {
    const outPath = await generateCatalogueTemplate("boutique", undefined, root);
    assert.match(outPath, /boutique-ratecard\.xlsx$/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outPath);
    const sheet = workbook.worksheets[0];
    const headers = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
    assert.deepEqual(headers, ["Code", "Garment", "Item", "Work type", "Unit", "Rate", "GST%"]);
    assert.equal(sheet.rowCount, 15);
    const codes = new Set<string>();
    for (let row = 2; row <= sheet.rowCount; row++) codes.add(String(sheet.getRow(row).getCell(1).value));
    assert.ok(codes.has("SUIT-PLAIN"));
    assert.ok(codes.has("SUIT-LINING"));
    assert.ok(codes.has("SUIT-EMB-NECK"));
    assert.ok(codes.has("URGENT-48H"));
    assert.equal(codes.size, 14, "every code is unique");
  });
});

test("catalogue template: electrical has the expected columns and 6 rows", async () => {
  await withTrade("electrical", async (config, root) => {
    const outPath = await generateCatalogueTemplate("electrical", undefined, root);
    assert.match(outPath, /electrical-catalogue\.xlsx$/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outPath);
    const sheet = workbook.worksheets[0];
    const headers = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
    assert.deepEqual(headers, ["SKU", "Brand", "Name", "Category", "Unit", "Price", "GST%"]);
    assert.equal(sheet.rowCount, 7);
  });
});

test("importing the boutique template with no brand column succeeds and derives no extra codes (the template already has a code column)", async () => {
  await withTrade("boutique", async (config, root) => {
    const activity = new ActivityLog(config.activityPath); await activity.init();
    const service = new CommerceService(config, activity, noopRag);
    try {
      const templatePath = await generateCatalogueTemplate("boutique", undefined, root);
      const imported = await service.importCatalogue(templatePath) as { documentId: string; imported: number };
      assert.equal(imported.imported, 14);
      await service.publish(imported.documentId);
      const found = (await service.search("SUIT-LINING", undefined, false)) as { products: Array<{ brand: string; sku: string }> };
      assert.equal(found.products.length, 1);
      assert.equal(found.products[0].brand, "She Fashion House");
    } finally { service.close(); }
  });
});

test("a rate-card sheet with no code column derives stable, deduplicated codes from category+name", async () => {
  await withTrade("boutique", async (config, root) => {
    const activity = new ActivityLog(config.activityPath); await activity.init();
    const service = new CommerceService(config, activity, noopRag);
    try {
      const csv = path.join(root, "no-code.csv");
      await fs.writeFile(csv, "Garment,Item,Unit,Rate,GST\nSuit,Plain stitching,per piece,600,5\nSuit,Plain stitching,per piece,650,5\n");
      const imported = await service.importCatalogue(csv) as { documentId: string; imported: number };
      assert.equal(imported.imported, 2);
      await service.publish(imported.documentId);
      const rows = (await service.search("", undefined, false)) as { products: Array<{ sku: string; brand: string }> };
      const skus = rows.products.map((item) => item.sku).sort();
      assert.deepEqual(skus, ["SUIT-PLAIN-STITCHING", "SUIT-PLAIN-STITCHING-2"]);
      for (const item of rows.products) assert.equal(item.brand, "She Fashion House");
    } finally { service.close(); }
  });
});

test("createQuote without a brand prices a boutique stitching job correctly in paise with 5% GST", async () => {
  await withTrade("boutique", async (config, root) => {
    const activity = new ActivityLog(config.activityPath); await activity.init();
    const service = new CommerceService(config, activity, noopRag);
    try {
      const templatePath = await generateCatalogueTemplate("boutique", undefined, root);
      const imported = await service.importCatalogue(templatePath) as { documentId: string };
      await service.publish(imported.documentId);
      const quote = service.createQuote({
        lines: [
          { sku: "SUIT-LINING", quantity: 2 },
          { sku: "SUIT-EMB-NECK", quantity: 1 },
          { sku: "URGENT-48H", quantity: 2 },
        ],
      });
      assert.equal(quote.complete, true);
      assert.equal(quote.brand, "She Fashion House");
      // 2*850 + 1*450 + 2*200 = 2550 rupees subtotal; +5% GST = 2677.50 -> 267750 paise.
      assert.equal(quote.subtotalPaise, 255_000);
      assert.equal(quote.taxPaise, 12_750);
      assert.equal(quote.totalPaise, 267_750);
      const output = path.join(root, "quote.xlsx");
      await service.exportQuote(quote.id, output);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(output);
      const sheet = workbook.getWorksheet("Quotation");
      assert.ok(sheet);
    } finally { service.close(); }
  });
});

test("electrical still requires a brand for createQuote", async () => {
  await withTrade("electrical", async (config, root) => {
    const activity = new ActivityLog(config.activityPath); await activity.init();
    const service = new CommerceService(config, activity, noopRag);
    try {
      const templatePath = await generateCatalogueTemplate("electrical", undefined, root);
      const imported = await service.importCatalogue(templatePath) as { documentId: string };
      await service.publish(imported.documentId);
      assert.throws(() => service.createQuote({ lines: [{ sku: "ELEC-MCB-16A", quantity: 1 }] }), /A brand is required/);
    } finally { service.close(); }
  });
});
