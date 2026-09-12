import type { CalculatedQuoteLine, CatalogueProduct } from "./types.ts";

export function parseQuantityMilli(value: string | number): number {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,3})?$/.test(text)) throw new Error(`Invalid quantity: ${value}`);
  const [whole, fraction = ""] = text.split(".");
  const result = Number(whole) * 1000 + Number(fraction.padEnd(3, "0"));
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`Quantity must be positive: ${value}`);
  return result;
}

function roundDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function applyBasisPoints(value: bigint, basisPoints: number): bigint {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new Error(`Invalid basis points: ${basisPoints}`);
  }
  return roundDivide(value * BigInt(basisPoints), 10_000n);
}

function safeNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("Quotation amount exceeds the safe integer range");
  return result;
}

export function calculateLine(
  product: CatalogueProduct,
  quantity: string | number,
  lineDiscountBasisPoints = 0,
  basketDiscountBasisPoints = 0,
): CalculatedQuoteLine {
  const quantityMilli = parseQuantityMilli(quantity);
  if (!Number.isSafeInteger(product.pricePaise) || product.pricePaise < 0) throw new Error(`Invalid price for ${product.sku}`);
  const gross = roundDivide(BigInt(product.pricePaise) * BigInt(quantityMilli), 1000n);
  const lineDiscount = applyBasisPoints(gross, lineDiscountBasisPoints);
  const afterLine = gross - lineDiscount;
  const basketDiscount = applyBasisPoints(afterLine, basketDiscountBasisPoints);
  const afterDiscount = afterLine - basketDiscount;
  const gst = product.gstBasisPoints ?? 0;
  let taxable = afterDiscount;
  let tax = applyBasisPoints(taxable, gst);
  let total = taxable + tax;
  if (product.taxInclusive) {
    total = afterDiscount;
    taxable = gst === 0 ? total : roundDivide(total * 10_000n, BigInt(10_000 + gst));
    tax = total - taxable;
  }
  return {
    productId: product.id,
    sku: product.sku,
    brand: product.brand,
    name: product.name,
    quantityMilli,
    unit: product.unit || "unit",
    unitPricePaise: product.pricePaise,
    grossPaise: safeNumber(gross),
    discountPaise: safeNumber(lineDiscount + basketDiscount),
    taxablePaise: safeNumber(taxable),
    taxPaise: safeNumber(tax),
    totalPaise: safeNumber(total),
    evidence: `${product.documentId}:${product.sourceLocation}`,
  };
}

export function formatRupees(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new Error("Invalid paise value");
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(paise / 100);
}
