import test from "node:test";
import assert from "node:assert/strict";
import { parseLinesOption } from "../src/commerce/commands.ts";

test("parseLinesOption: <sku> x<qty> spelling", () => {
  assert.deepEqual(parseLinesOption("SUIT-LINING x2"), [{ sku: "SUIT-LINING", quantity: 2 }]);
});

test("parseLinesOption: <qty> x <sku> spelling", () => {
  assert.deepEqual(parseLinesOption("2 x SUIT-LINING"), [{ sku: "SUIT-LINING", quantity: 2 }]);
});

test("parseLinesOption: <qty>x<sku> spelling with no spaces", () => {
  assert.deepEqual(parseLinesOption("2xSUIT-LINING"), [{ sku: "SUIT-LINING", quantity: 2 }]);
});

test("parseLinesOption: decimal quantities", () => {
  assert.deepEqual(parseLinesOption("ELEC-WIRE-1.5 x2.5"), [{ sku: "ELEC-WIRE-1.5", quantity: 2.5 }]);
  assert.deepEqual(parseLinesOption("2.5 x ELEC-WIRE-1.5"), [{ sku: "ELEC-WIRE-1.5", quantity: 2.5 }]);
});

test("parseLinesOption: multiple items with trailing spaces around commas", () => {
  assert.deepEqual(
    parseLinesOption("SUIT-LINING x2,  SUIT-EMB-NECK x1 ,URGENT-48H x2  "),
    [
      { sku: "SUIT-LINING", quantity: 2 },
      { sku: "SUIT-EMB-NECK", quantity: 1 },
      { sku: "URGENT-48H", quantity: 2 },
    ],
  );
});

test("parseLinesOption: free text with spaces becomes a query line, not a sku", () => {
  assert.deepEqual(parseLinesOption("blue silk saree fall x1"), [{ query: "blue silk saree fall", quantity: 1 }]);
});

test("parseLinesOption: empty input is a usage error", () => {
  assert.throws(() => parseLinesOption(""), /Usage/);
  assert.throws(() => parseLinesOption("   "), /Usage/);
  assert.throws(() => parseLinesOption(" , , "), /Usage/);
});

test("parseLinesOption: an item with no quantity marker is a usage error", () => {
  assert.throws(() => parseLinesOption("SUIT-LINING"), /Usage/);
});
