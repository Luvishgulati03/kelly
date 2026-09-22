/**
 * Turns a chat reply into a short, TTS-safe sentence or two. The spoken price, when a
 * calculated quote is supplied, always comes from `quote.totalPaise` in code — never from
 * whatever number the model happened to write in prose — so what the customer hears always
 * matches the document Kelly can export.
 */
import type { CalculatedQuote } from "../commerce/types.ts";

export interface SpeakableSummaryInput {
  reply: string;
  quote?: CalculatedQuote;
  shopName?: string;
  maxChars?: number;
}

const SPOKEN_FENCE = /```spoken\s*\n?([\s\S]*?)```/i;

/** Splits a reply into its ```spoken fenced block (if any) and the reply with that block removed. */
export function extractSpokenBlock(reply: string): { block?: string; rest: string } {
  const match = SPOKEN_FENCE.exec(reply);
  if (!match) return { rest: reply };
  const rest = (reply.slice(0, match.index) + reply.slice(match.index + match[0].length)).replace(/\n{3,}/g, "\n\n").trim();
  return { block: match[1].trim(), rest };
}

/** The reply with any ```spoken fence removed, for display in chat/history. */
export function stripSpokenBlock(reply: string): string {
  return extractSpokenBlock(reply).rest;
}

function firstPlainParagraph(text: string): string {
  const trimmed = text.trim();
  const blankLine = trimmed.search(/\n\s*\n/);
  return blankLine === -1 ? trimmed : trimmed.slice(0, blankLine);
}

/** Strips markdown and normalises currency notation for a TTS engine. Pure text transform. */
export function stripForSpeech(text: string): string {
  let result = text;
  result = result.replace(/```[\s\S]*?```/g, " ");
  result = result.replace(/^#{1,6}\s*/gm, "");
  result = result.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "link");
  result = result.replace(/(\*\*|__)(.*?)\1/g, "$2");
  result = result.replace(/(\*|_)(.*?)\1/g, "$2");
  result = result.replace(/`([^`]*)`/g, "$1");
  // Drop markdown table rows (data rows and the |---|---| separator row) rather than
  // reading pipes and dashes aloud.
  result = result
    .split("\n")
    .filter((line) => !/^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$/.test(line))
    .map((line) => line.replace(/\|/g, " "))
    .join("\n");
  result = result.replace(/(?:₹|Rs\.?)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/gi, (_all, amount: string) => `${amount} rupees`);
  result = result.replace(/\s+/g, " ").trim();
  return result;
}

/** Indian digit grouping, e.g. 1234567 -> "12,34,567". */
function indianGroup(value: number): string {
  const text = String(Math.trunc(Math.abs(value)));
  if (text.length <= 3) return text;
  const last3 = text.slice(-3);
  const rest = text.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${rest},${last3}`;
}

/** "6,053 rupees and 40 paise" (paise dropped when zero). */
export function formatRupeesForSpeech(paise: number): string {
  const whole = Math.floor(Math.abs(paise) / 100);
  const remainder = Math.abs(paise) % 100;
  const rupeesText = `${indianGroup(whole)} rupees`;
  return remainder === 0 ? rupeesText : `${rupeesText} and ${remainder} paise`;
}

function withPriceSentence(base: string, priceSentence: string): string {
  const sentences = base.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
  const index = sentences.findIndex((sentence) => /rupees/i.test(sentence));
  if (index >= 0) sentences[index] = priceSentence;
  else sentences.push(priceSentence);
  return sentences.join(" ").trim();
}

/** Cuts text at or before maxChars, on the nearest sentence boundary when one exists. */
function capAtSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const window = text.slice(0, maxChars);
  const lastBoundary = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  if (lastBoundary > 0) return window.slice(0, lastBoundary + 1).trim();
  return window.trim();
}

/**
 * Builds the sentence(s) a TTS voice reads for a chat turn. Prefers a ```spoken fence the
 * model was told to emit for voice turns; otherwise falls back to the reply's first plain
 * paragraph. When a quote is supplied, the price sentence is always built from
 * `quote.totalPaise` in code, replacing or appending to whatever prose mentioned a price.
 */
export function speakableSummary(input: SpeakableSummaryInput): string {
  const maxChars = input.maxChars ?? 400;
  const { block, rest } = extractSpokenBlock(input.reply);
  const source = block ?? firstPlainParagraph(rest);
  let text = stripForSpeech(source);
  if (input.quote) {
    const priceSentence = input.quote.complete
      ? `Grand total ${formatRupeesForSpeech(input.quote.totalPaise)} including GST.`
      : "The quotation still has an unresolved line.";
    text = withPriceSentence(text, priceSentence);
  }
  return capAtSentence(text, maxChars);
}

/**
 * Best-effort extraction of a quote id from a chat reply. There is no structured tool-result
 * hook between the CLI and the dashboard chat route, so this parses either the phrase
 * "quote id <uuid>" or a raw `"id": "<uuid>"` field from JSON the model may have echoed back
 * (e.g. `kelly quote create` output). If neither pattern is present, no quote is attached and
 * the spoken summary falls back to prose; this is a known limitation, not a guarantee.
 */
export function extractQuoteIdFromReply(reply: string): string | undefined {
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const phrase = new RegExp(`quote\\s*(?:id)?[:\\s]+(${uuid})`, "i").exec(reply);
  if (phrase) return phrase[1];
  const json = new RegExp(`"id"\\s*:\\s*"(${uuid})"`, "i").exec(reply);
  return json?.[1];
}
