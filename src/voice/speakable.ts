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
 * hook between the CLI and the dashboard chat route, so this tolerantly parses prose labels
 * ("quote id", "quotation id", "quote", "quotation") — optionally wrapped in backticks,
 * asterisks, or quotes from markdown formatting, and separated from the uuid by any short run
 * of punctuation/whitespace (e.g. `: `, ` #Q: `) — as well as a raw `"id": "<uuid>"` field from
 * JSON the model may have echoed back (e.g. `kelly quote create` output). A bare, unquoted "id"
 * is deliberately NOT treated as a label on its own: it would also match unrelated labels like
 * "conversation id", so only the quoted JSON key form counts as an "id" label. Only the first
 * uuid found immediately after one of these labels is returned; uuids elsewhere in the reply
 * (e.g. a conversation id) are ignored. If no label is present, no quote is attached and the
 * spoken summary falls back to prose; this is a known limitation, not a guarantee.
 */
export function extractQuoteIdFromReply(reply: string): string | undefined {
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const label = String.raw`(?:\b(?:quotation\s*id|quote\s*id|quotation|quote)\b|"id")`;
  const match = new RegExp(`${label}[^\\n]{0,20}?(${uuid})`, "i").exec(reply);
  return match?.[1];
}

/**
 * Splits text into sentence-sized chunks for sequential TTS synthesis — on `.`, `?`, `!`, and
 * the Hindi/Devanagari full stop (danda, `।`), each kept with its own delimiter. Whitespace-only
 * pieces are dropped. A text with none of those delimiters comes back as a single chunk (the
 * whole trimmed input), never empty for non-empty input.
 */
export function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const pieces = trimmed.match(/[^.?!।]+[.?!।]*/gu) ?? [trimmed];
  return pieces.map((piece) => piece.trim()).filter(Boolean);
}

/**
 * Streamed-token watcher for a voice turn's leading ```spoken fence (see the voiceMode
 * instruction in `src/dashboard/server.ts`, which tells Kelly to put that fence FIRST). Feed
 * every streamed text chunk to `push`; its return value is what should still reach the
 * client as a visible `token` event.
 *
 * Three phases:
 *   buffering  — not yet enough text to know whether the reply opens with the fence. Nothing
 *                is shown yet.
 *   in-fence   — the opener matched; text is captured as the fence body (never shown) until
 *                the closing ``` arrives, at which point `onSpoken` fires exactly once with
 *                the body normalised through `stripForSpeech`.
 *   passthrough — either the closing fence was just consumed, or the buffered prefix proved
 *                the reply does NOT open with the fence (in which case everything buffered so
 *                far is flushed as the return value on that transition). Every push after this
 *                point returns its input unchanged.
 */
export function createSpokenFenceFilter(onSpoken: (text: string) => void): { push: (text: string) => string } {
  const opener = "```spoken";
  let phase: "buffering" | "in-fence" | "passthrough" = "buffering";
  let buffer = "";
  let fenceBody = "";

  function push(text: string): string {
    if (phase === "passthrough") return text;
    if (phase === "in-fence") {
      fenceBody += text;
      const closeIndex = fenceBody.indexOf("```");
      if (closeIndex === -1) return "";
      const body = fenceBody.slice(0, closeIndex);
      const after = fenceBody.slice(closeIndex + 3);
      fenceBody = "";
      phase = "passthrough";
      onSpoken(stripForSpeech(body));
      return after;
    }
    // buffering
    buffer += text;
    const trimmed = buffer.replace(/^\s+/, "");
    if (!trimmed) return ""; // still all whitespace so far; keep waiting
    const compareLen = Math.min(trimmed.length, opener.length);
    if (trimmed.slice(0, compareLen).toLowerCase() !== opener.slice(0, compareLen)) {
      // The reply does not open with the fence: everything buffered becomes visible now.
      phase = "passthrough";
      const flushed = buffer;
      buffer = "";
      return flushed;
    }
    if (trimmed.length < opener.length) return ""; // still a matching prefix; keep waiting
    const rest = trimmed.slice(opener.length);
    const bodyStart = rest.startsWith("\n") ? rest.slice(1) : rest;
    phase = "in-fence";
    buffer = "";
    return push(bodyStart);
  }

  return { push };
}
