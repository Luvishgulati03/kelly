import test from "node:test";
import assert from "node:assert/strict";
import { calculateLine, parseQuantityMilli } from "../src/commerce/money.ts";
import type { CatalogueProduct } from "../src/commerce/types.ts";

const product: CatalogueProduct = {
  id: "p1", documentId: "d1", sku: "0007", brand: "Acme", name: "MCB 16A", category: "MCB",
  unit: "piece", packSize: 1, pricePaise: 10_000, gstBasisPoints: 1_800, taxInclusive: false,
  sourceLocation: "Price List!A2:H2", status: "published", importedAt: "2026-01-01T00:00:00.000Z",
};

test("quantity parser preserves three decimal places", () => {
  assert.equal(parseQuantityMilli("1.250"), 1250);
  assert.throws(() => parseQuantityMilli("1.0001"));
  assert.throws(() => parseQuantityMilli(0));
});

test("quote line uses deterministic paise discounts and GST", () => {
  const line = calculateLine(product, 10, 1000);
  assert.equal(line.grossPaise, 100_000);
  assert.equal(line.discountPaise, 10_000);
  assert.equal(line.taxablePaise, 90_000);
  assert.equal(line.taxPaise, 16_200);
  assert.equal(line.totalPaise, 106_200);
});

test("tax-inclusive price is decomposed without changing total", () => {
  const line = calculateLine({ ...product, pricePaise: 11_800, taxInclusive: true }, 1);
  assert.equal(line.taxablePaise, 10_000);
  assert.equal(line.taxPaise, 1_800);
  assert.equal(line.totalPaise, 11_800);
});
