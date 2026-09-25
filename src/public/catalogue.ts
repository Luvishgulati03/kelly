import { calculateLine, formatRupees } from "../commerce/money.ts";
import type { CommerceStore } from "../commerce/store.ts";
import type { CatalogueProduct } from "../commerce/types.ts";
import type { TradePack } from "../trade/index.ts";

/**
 * SERVER-SIDE CATALOGUE WORK for a public turn. The public model has no tools, so everything it
 * may say about items and prices is looked up and calculated HERE, in code, from the published
 * catalogue or rate card only, and handed to it as quoted data:
 *
 *   - matching published rows (brand, SKU, name, unit, price before tax, GST rate, price per unit
 *     including GST), never a supplier file path, document id, or row location;
 *   - when the visitor names quantities ("5 x SKU-1", "3 metres of wire", "2 blouse lining"), a
 *     quotation computed with Kelly's own deterministic paise maths (calculateLine), with every
 *     line that did not resolve to exactly one product listed as unresolved.
 *
 * Nothing here writes: no quote row is saved, no Excel file is generated, no design is marked
 * shown. Discounts are never applied for a visitor (they are the owner's decision).
 */

export interface PublicQuoteLine {
  sku: string;
  brand: string;
  name: string;
  unit: string;
  quantity: string;
  unitPricePaise: number;
  taxPaise: number;
  totalPaise: number;
  gstPercent: number;
}

export interface PublicQuote {
  lines: PublicQuoteLine[];
  unresolved: Array<{ text: string; quantity: string; options: string[] }>;
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
}

export interface PublicCatalogueContext {
  /** The prompt block (empty when this install has no catalogue service). */
  block: string;
  /** True when the visitor's words look like a price, quote or item lookup. */
  lookup: boolean;
  quote?: PublicQuote;
  matched: number;
}

const IGNORED_TERMS = new Set([
  "what", "which", "show", "list", "have", "need", "want", "would", "with", "from", "same", "available",
  "product", "products", "item", "items", "quotation", "quote", "please", "one", "each", "that", "this",
  "and", "how", "much", "cost", "could", "should", "the", "for", "me", "price", "prices", "rate", "rates",
  "kya", "hai", "kitna", "kitne", "ka", "ki", "ke", "chahiye", "mujhe", "do", "de", "dijiye", "batao",
  "you", "your", "can", "are", "any", "get", "give", "tell", "about", "some", "all", "total",
]);

const LOOKUP = /\b(price|prices|rate|rates|cost|costs|quote|quotation|estimate|total|gst|how much|kitna|kitne|kya rate|stitch|stitching|catalog(?:ue)?|rate card|stock|available|sku|brand|buy|order|need|chahiye)\b|₹|\brs\.?\s?\d|\d+\s*(?:x|×|nos?|pcs?|pieces?|units?|meters?|metres?|mtrs?|m|rolls?|boxes?|pairs?|sets?)\b/i;

export function looksLikeLookup(message: string): boolean {
  return LOOKUP.test(message);
}

function terms(text: string): string[] {
  const found = text.toLowerCase().match(/[a-z0-9][a-z0-9.-]{1,}/g) ?? [];
  return [...new Set(found.filter((term) => !IGNORED_TERMS.has(term) && !/^\d+(?:\.\d+)?$/.test(term)))];
}

function published(store: CommerceStore, query: string): CatalogueProduct[] {
  return store.search(query, undefined, false).filter((item) => item.status === "published");
}

/** Published products matching the visitor's words, best first (exact SKU, then term hits). */
export function matchProducts(store: CommerceStore, text: string, limit = 10): CatalogueProduct[] {
  const scores = new Map<string, { product: CatalogueProduct; score: number }>();
  const bump = (items: CatalogueProduct[], weight: number): void => {
    for (const item of items) {
      const entry = scores.get(item.id) ?? { product: item, score: 0 };
      entry.score += weight;
      scores.set(item.id, entry);
    }
  };
  const clean = text.trim();
  if (clean && clean.length <= 80) bump(published(store, clean), 5);
  for (const term of terms(clean).slice(0, 16)) {
    const hits = published(store, term);
    const exactSku = hits.filter((item) => item.sku.toLowerCase() === term);
    bump(exactSku, 10);
    bump(hits, 1);
  }
  return [...scores.values()].sort((a, b) => b.score - a.score || a.product.brand.localeCompare(b.product.brand) || a.product.name.localeCompare(b.product.name))
    .slice(0, limit).map((entry) => entry.product);
}

const QTY_UNITS = "(?:x|×|nos?|pcs?|pieces?|units?|meters?|metres?|mtrs?|m|rolls?|boxes?|pairs?|sets?)";
const QTY = "\\d{1,5}(?:\\.\\d{1,3})?";
// "<qty> [unit] [of] <item>", where the quantity is a whole token (never the "32" of "MCB-32A")
// and the item runs to the next separator or the next "<qty> <item>".
const LEADING = new RegExp(
  `(?<![\\w.\\-/])(${QTY})(?:\\s*${QTY_UNITS})?\\s+(?:of\\s+)?([a-z0-9][a-z0-9 .\\-/]{0,48}?)`
  + `(?=\\s*(?:,|\\band\\b|\\baur\\b|\\+|;|\\.\\s|\\.$|\\?|!|$)|\\s+${QTY}(?:\\s*${QTY_UNITS})?\\s+[a-z])`,
  "gi",
);
// "<item> x <qty>" (the x stands apart from the item, so "box 2" is not "bo x 2").
const TRAILING = new RegExp(`(?<![\\w\\-/])([a-z][a-z0-9\\-/.]{1,30})\\s+(?:x|×)\\s*(${QTY})\\b`, "gi");

/** "5 x SKU-1, 3 metres of 2.5 sqmm wire and SKU-9 x2" -> [{text, quantity}]. */
export function parseQuantities(message: string): Array<{ text: string; quantity: string }> {
  const lines: Array<{ text: string; quantity: string }> = [];
  const seen = new Set<string>();
  const add = (text: string, quantity: string): void => {
    const clean = text.replace(/\s+/g, " ").trim().replace(/[.,;:]+$/, "")
      .replace(/(?:\s+(?:please|pls|chahiye|chaiye|dijiye|dena|do|de|hai|ka|ki|ke|rate|price|kitna|kitne|batao))+$/i, "");
    if (!clean || !terms(clean).length) return;
    const quantityValue = Number(quantity);
    if (!Number.isFinite(quantityValue) || quantityValue <= 0 || quantityValue > 10_000) return;
    const key = `${clean.toLowerCase()}|${quantity}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push({ text: clean, quantity });
  };
  for (const match of message.matchAll(TRAILING)) add(match[1], match[2]);
  for (const match of message.matchAll(LEADING)) add(match[2], match[1]);
  return lines.slice(0, 12);
}

function brandFilter(products: CatalogueProduct[], message: string): CatalogueProduct[] {
  const lower = message.toLowerCase();
  const brands = [...new Set(products.map((item) => item.brand))].filter((brand) => brand && lower.includes(brand.toLowerCase()));
  return brands.length === 1 ? products.filter((item) => item.brand === brands[0]) : products;
}

function withGst(product: CatalogueProduct): number {
  return calculateLine(product, 1).totalPaise;
}

/** Quotation for the parsed lines, in integer paise, computed only in code. */
export function publicQuote(store: CommerceStore, message: string, lines = parseQuantities(message)): PublicQuote | undefined {
  if (!lines.length) return undefined;
  const quote: PublicQuote = { lines: [], unresolved: [], subtotalPaise: 0, taxPaise: 0, totalPaise: 0 };
  for (const line of lines) {
    let candidates = brandFilter(matchProducts(store, line.text, 6), message);
    const exact = candidates.filter((item) => item.sku.toLowerCase() === line.text.toLowerCase());
    if (exact.length === 1) candidates = exact;
    if (candidates.length !== 1) {
      quote.unresolved.push({
        text: line.text, quantity: line.quantity,
        options: candidates.slice(0, 4).map((item) => `${item.brand} ${item.name} (${item.sku}) ${formatRupees(withGst(item))} per ${item.unit || "unit"} incl. GST`),
      });
      continue;
    }
    const product = candidates[0];
    let calculated;
    try { calculated = calculateLine(product, line.quantity); } catch { quote.unresolved.push({ text: line.text, quantity: line.quantity, options: [] }); continue; }
    quote.lines.push({
      sku: product.sku, brand: product.brand, name: product.name, unit: product.unit || "unit", quantity: line.quantity,
      unitPricePaise: product.pricePaise, taxPaise: calculated.taxPaise, totalPaise: calculated.totalPaise,
      gstPercent: (product.gstBasisPoints || 0) / 100,
    });
    quote.subtotalPaise += calculated.taxablePaise;
    quote.taxPaise += calculated.taxPaise;
    quote.totalPaise += calculated.totalPaise;
  }
  return quote;
}

/** Visitor-derived text inside a server block: no tags, no quotes, no control characters. */
function inert(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/</g, "‹").replace(/>/g, "›").replace(/"/g, "'").slice(0, 60);
}

function productLine(item: CatalogueProduct): string {
  const gst = (item.gstBasisPoints || 0) / 100;
  const basis = item.taxInclusive ? "price includes GST" : "price before GST";
  const clean = (value: string): string => value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/</g, "‹").replace(/>/g, "›").slice(0, 160);
  return `- ${clean(item.brand)} | ${clean(item.sku)} | ${clean(item.name)}${item.specification ? ` | ${clean(item.specification)}` : ""} | per ${clean(item.unit || "unit")}: ${formatRupees(item.pricePaise)} (${basis}), GST ${gst}%, ${formatRupees(withGst(item))} including GST`;
}

function quoteBlock(quote: PublicQuote): string[] {
  const out = ["<server_quote>", "Computed by the shop's server in code. Use these exact amounts; never recalculate, round differently, or add a discount."];
  for (const line of quote.lines) {
    out.push(`- ${line.quantity} ${line.unit} x ${line.brand} ${line.name} (${line.sku}): ${formatRupees(line.totalPaise)} including GST ${line.gstPercent}% (${formatRupees(line.taxPaise)} tax)`);
  }
  if (quote.lines.length) {
    out.push(`Subtotal before GST: ${formatRupees(quote.subtotalPaise)}. GST: ${formatRupees(quote.taxPaise)}. Total: ${formatRupees(quote.totalPaise)}.`);
  }
  for (const item of quote.unresolved) {
    out.push(`- UNRESOLVED "${inert(item.text)}" x ${item.quantity}: ${item.options.length ? `ask which one: ${item.options.join("; ")}` : "not found in the published list; say so and ask what they meant"}.`);
  }
  if (quote.unresolved.length) out.push("The quotation is INCOMPLETE until every unresolved line is clarified; do not state a grand total that includes them.");
  out.push("No discount is applied. If asked for a discount, say the shop owner decides discounts at the counter.");
  out.push("</server_quote>");
  return out;
}

/**
 * The catalogue block for one public turn. `followUp` is the visitor's previous message, so a
 * follow-up like "and for 10 of them?" still finds the product the visitor was talking about.
 */
export function publicCatalogueContext(store: CommerceStore | undefined, pack: TradePack, message: string, followUp?: string): PublicCatalogueContext {
  const lookup = looksLikeLookup(message);
  if (!store) return { block: "", lookup, matched: 0 };
  let products = matchProducts(store, message);
  if (!products.length && followUp) products = matchProducts(store, followUp);
  const broad = !products.length && /\b(what|which|show|list|catalog(?:ue)?|rate card|categories|menu|sell|have)\b/i.test(message);
  const all = broad ? published(store, "") : [];
  if (broad) products = all.slice(0, 10);
  const quote = publicQuote(store, message);
  const categories = broad ? [...new Set(all.map((item) => item.category))].sort() : [];
  const noun = pack.catalogueNoun;
  const lines = [
    `<shop_catalogue>`,
    `Rows from the shop's published ${noun}, looked up by the server for this message. They are the ONLY source for items, SKUs, prices and GST.`,
    ...(categories.length ? [`Categories: ${categories.join(", ")}.`] : []),
    ...(products.length ? products.map(productLine) : [`No published ${noun} row matched this message. If they asked about an item or price, say you could not find it and ask them to describe it differently; never guess a price.`]),
    ...(quote ? quoteBlock(quote) : []),
    `</shop_catalogue>`,
  ];
  return { block: lines.join("\n"), lookup: lookup || Boolean(quote), quote, matched: products.length };
}
