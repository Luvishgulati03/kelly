import type { TradePack } from "../trade/index.ts";
import { resolveTerm, tokenize } from "../designs/vocabulary.ts";

/**
 * Decides whether a counter voice turn is a LOOKUP: the customer wants a price/quotation or
 * wants to see items (designs, a category, the catalogue). Only a lookup earns the Talk
 * page's holding phrase ("Please wait a few moments while I gather the information you
 * need."); small talk (hello, thanks, bye, kaise ho) never does.
 *
 * Pure and deterministic, and deliberately conservative: an unclear request is NOT a lookup.
 * The dashboard also signals `gathering` when the model actually starts a tool/command, which
 * covers the lookups this classifier misses.
 */

/** Latin price/quotation words, matched as whole tokens. */
const PRICE_WORDS = new Set([
  "price", "prices", "pricing", "priced", "rate", "rates", "cost", "costs", "costing",
  "charge", "charges", "kitna", "kitne", "kitni", "daam", "dam", "quote", "quotes",
  "quotation", "quotations", "estimate", "estimates", "bill", "total", "gst", "rupees",
  "rupee", "rs",
]);

/** Latin "show me / find me" words, matched as whole tokens. "show" and "available" are
 *  deliberately absent: "show me lehengas" still counts through the category, "are you
 *  available?" is small talk. */
const SEE_WORDS = new Set([
  "design", "designs", "dikhao", "dikhaiye", "dikhayiye", "dikha", "dikhana",
  "dekhna", "collection", "collections", "options", "catalogue", "catalog",
  "stock", "latest", "trending",
]);

/** Latin multi-word phrases, matched on the normalised text. */
const PRICE_PHRASES = [/\bhow\s+much\b/, /\brate\s+kya\b/, /\bstitching\s+charges?\b/];

/** Devanagari and symbol cues, matched as substrings of the NFC-normalised text. */
const DEVANAGARI_CUES = [
  "सिलाई", "कितना", "कितने", "कितनी", "दाम", "रेट", "कीमत", "खर्च",
  "दिखाओ", "दिखाइए", "दिखाइये", "डिज़ाइन", "डिजाइन", "₹",
].map((cue) => cue.normalize("NFC"));

/**
 * Small-talk words. They never count as a pack term, even when the pack's fuzzy vocabulary
 * match would otherwise stretch to them. Small talk on its own is never a lookup (there is
 * nothing to look up); mixed with a real cue ("thanks, how much for 2 suits?") it still is.
 */
const SMALL_TALK = new Set([
  "hello", "hi", "hey", "namaste", "namaskar", "bye", "goodbye", "alvida", "thanks", "thank",
  "you", "shukriya", "dhanyavad", "dhanyawad", "ok", "okay", "theek", "thik", "hai", "accha",
  "acha", "achha", "kaise", "ho", "how", "are", "who", "good", "great", "nice", "sure", "said",
  "have", "day", "see", "later", "fine", "well", "done", "welcome", "morning", "evening",
  "night", "sir", "madam", "ji", "haan", "han", "yes", "no", "nahi", "please",
  // Everyday words one edit away from a garment ("down"/"town" -> gown).
  "down", "town", "own", "brown",
]);

/** Number words (English, Hinglish, Hindi) that can start a quantity. */
const NUMBER_WORDS = [
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "twelve",
  "twenty", "fifty", "hundred", "dozen", "ek", "do", "teen", "char", "chaar", "paanch",
  "panch", "chhe", "chhah", "saat", "aath", "nau", "das", "bees", "pachas", "sau",
  "एक", "दो", "तीन", "चार", "पांच", "पाँच", "छह", "सात", "आठ", "नौ", "दस",
];

/** Units that make a number a quantity on their own ("3 metres", "10 pcs"). */
const UNIT_WORDS = new Set([
  "m", "mtr", "mtrs", "meter", "meters", "metre", "metres", "yard", "yards", "yd", "yds",
  "cm", "mm", "inch", "inches", "ft", "feet", "kg", "g", "gram", "grams", "pc", "pcs",
  "piece", "pieces", "set", "sets", "pair", "pairs", "box", "boxes", "roll", "rolls", "coil",
  "coils", "unit", "units", "nos", "dozen", "sqmm", "amp", "amps", "ampere", "amperes",
  "packet", "packets",
]);

const QUANTITY = new RegExp(
  `(?:^|[^a-z0-9ऀ-ॿ])(?:\\d+\\s*|(?:${NUMBER_WORDS.join("|")})\\s+)([a-z][a-z-]*|[ऀ-ॿ]+)`,
  "g",
);

function normalise(prompt: string): string {
  return prompt.normalize("NFC").toLowerCase();
}

function resolvedKind(token: string, pack: TradePack): "category" | "tag" | undefined {
  if (SMALL_TALK.has(token)) return undefined;
  const resolved = resolveTerm(token, pack);
  // A bare "new"/"recent" (latest intent) is too common in small talk to mean a lookup; the
  // literal words "latest" and "trending" are already SEE_WORDS.
  return resolved?.kind === "category" || resolved?.kind === "tag" ? resolved.kind : undefined;
}

/** A garment category counts on its own ("lehenga?"); an occasion tag ("wedding", "party")
 *  only as part of a quantity or next to a design/price word, so "I'm off to a wedding, bye"
 *  stays small talk. */
function namesPackTerm(token: string, pack: TradePack): boolean {
  return resolvedKind(token, pack) === "category";
}
function namesPackTermOrTag(token: string, pack: TradePack): boolean {
  return resolvedKind(token, pack) !== undefined;
}

function namesPackVocabulary(word: string, pack: TradePack): boolean {
  return pack.vocabulary.some((entry) => entry.toLowerCase() === word);
}

function hasQuantity(text: string, pack: TradePack): boolean {
  for (const match of text.matchAll(QUANTITY)) {
    const word = match[1];
    if (UNIT_WORDS.has(word)) return true;
    if (namesPackVocabulary(word, pack)) return true;
    if (namesPackTermOrTag(word, pack)) return true;
  }
  return false;
}

/**
 * True when the prompt asks for a price/quotation or to see/find items, names one of the
 * pack's gallery categories/tags (aliases and whisper misspellings included) or its
 * catalogue noun, or carries a quantity with a unit or item word. False otherwise,
 * including every greeting, thanks, goodbye and bit of chit-chat.
 */
export function isLookupRequest(prompt: string, pack: TradePack): boolean {
  const text = normalise(prompt);
  if (!text.trim()) return false;

  if (PRICE_PHRASES.some((phrase) => phrase.test(text))) return true;
  if (DEVANAGARI_CUES.some((cue) => text.includes(cue))) return true;

  const catalogueNoun = pack.catalogueNoun.toLowerCase();
  if (catalogueNoun && new RegExp(`\\b${catalogueNoun.replace(/\s+/g, "\\s+")}\\b`).test(text)) return true;

  const tokens = tokenize(text);
  for (const token of tokens) {
    if (PRICE_WORDS.has(token) || SEE_WORDS.has(token)) return true;
  }
  for (const token of tokens) {
    if (namesPackTerm(token, pack)) return true;
  }
  return hasQuantity(text, pack);
}
