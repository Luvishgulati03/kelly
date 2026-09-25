import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { extractCatalogueRows } from "../src/commerce/workbooks.ts";

async function writeWorkbook(root: string, name: string, headers: string[], rows: unknown[][]): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  const outPath = path.join(root, name);
  await workbook.xlsx.writeFile(outPath);
  return outPath;
}

test("extractCatalogueRows: a sheet without a brand column rejects when brandRequired is true (electrical)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kelly-workbooks-"));
  const noBrandPath = await writeWorkbook(root, "no-brand.xlsx", ["SKU", "Name", "Price"], [["ELEC-1", "MCB 16A", 250]]);
  await assert.rejects(
    () => extractCatalogueRows(noBrandPath, { brandRequired: true, shopName: "Kelly's counter" }),
    /Missing required catalogue column: brand/,
  );
});

test("extractCatalogueRows: a sheet with a brand column succeeds when brandRequired is true (electrical)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kelly-workbooks-"));
  const withBrandPath = await writeWorkbook(
    root,
    "with-brand.xlsx",
    ["SKU", "Brand", "Name", "Price"],
    [["ELEC-1", "Havells", "MCB 16A", 250]],
  );
  const result = await extractCatalogueRows(withBrandPath, { brandRequired: true, shopName: "Kelly's counter" });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].brand, "Havells");
  assert.deepEqual(result.notes, []);
});

test("extractCatalogueRows: a sheet without a brand column succeeds when brandRequired is false (boutique) and notes the default", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kelly-workbooks-"));
  const noBrandPath = await writeWorkbook(
    root,
    "no-brand.xlsx",
    ["Garment", "Item", "Rate"],
    [["Suit", "Plain stitching", 600]],
  );
  const result = await extractCatalogueRows(noBrandPath, { brandRequired: false, shopName: "Sample Boutique" });
  assert.equal(result.rows.length, 1);
  for (const row of result.rows) assert.equal(row.brand, "Sample Boutique");
  assert.deepEqual(result.notes, ["brand column absent; rows branded as Sample Boutique"]);
});

test("extractCatalogueRows: a sheet with an explicit brand column keeps its brands even when brandRequired is false (boutique)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kelly-workbooks-"));
  const withBrandPath = await writeWorkbook(
    root,
    "with-brand.xlsx",
    ["Garment", "Brand", "Item", "Rate"],
    [["Suit", "Guest Designer", "Plain stitching", 600]],
  );
  const result = await extractCatalogueRows(withBrandPath, { brandRequired: false, shopName: "Sample Boutique" });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].brand, "Guest Designer");
  assert.deepEqual(result.notes, []);
});
