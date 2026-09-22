import test from "node:test";
import assert from "node:assert/strict";
import {
  speakableSummary,
  stripForSpeech,
  stripSpokenBlock,
  formatRupeesForSpeech,
  extractQuoteIdFromReply,
} from "../src/voice/speakable.ts";
import type { CalculatedQuote } from "../src/commerce/types.ts";

function quote(overrides: Partial<CalculatedQuote> = {}): CalculatedQuote {
  return {
    id: "quote-1", version: 1, brand: "house", complete: true, unresolved: [], lines: [],
    subtotalPaise: 0, discountPaise: 0, taxPaise: 0, totalPaise: 605_340,
    createdAt: new Date().toISOString(), validUntil: new Date().toISOString(),
    ...overrides,
  };
}

test("prefers a fenced spoken block over prose", () => {
  const reply = "Long explanation with **markdown** and a table.\n\n```spoken\nGot two suits with lining. Grand total 1,785 rupees.\n```\n";
  const result = speakableSummary({ reply });
  assert.equal(result, "Got two suits with lining. Grand total 1,785 rupees.");
});

test("falls back to the first plain paragraph when no fence is present", () => {
  const reply = "This is the **first** paragraph.\n\nThis is a second paragraph that should be ignored.";
  const result = speakableSummary({ reply });
  assert.equal(result, "This is the first paragraph.");
});

test("stripForSpeech removes markdown and normalises rupee notation", () => {
  const text = stripForSpeech("# Heading\nSee [the sheet](https://example.com) for `SUIT-PLAIN` at Rs 4,500 and ₹120.50.\n| A | B |\n|---|---|\n| 1 | 2 |");
  assert.match(text, /^Heading/);
  assert.match(text, /link/);
  assert.doesNotMatch(text, /`|\[|\]|\(|\)/);
  assert.match(text, /4,500 rupees/);
  assert.match(text, /120\.50 rupees/);
  assert.doesNotMatch(text, /\|/);
});

test("indian grouping in formatRupeesForSpeech", () => {
  assert.equal(formatRupeesForSpeech(12_345_600), "1,23,456 rupees");
  assert.equal(formatRupeesForSpeech(605_340), "6,053 rupees and 40 paise");
  assert.equal(formatRupeesForSpeech(50_000), "500 rupees");
});

test("a complete quote's total overrides prose in the spoken summary", () => {
  const reply = "```spoken\nHere is the total, about Rs 100 rupees maybe.\n```";
  const result = speakableSummary({ reply, quote: quote({ totalPaise: 605_340 }) });
  assert.equal(result, "Grand total 6,053 rupees and 40 paise including GST.");
});

test("an incomplete quote says the line is unresolved instead of a price", () => {
  const reply = "```spoken\nStill checking one item.\n```";
  const result = speakableSummary({ reply, quote: quote({ complete: false, totalPaise: 0 }) });
  assert.equal(result, "Still checking one item. The quotation still has an unresolved line.");
});

test("caps long text on a sentence boundary", () => {
  const sentence = "This is a normal sentence that repeats. ";
  const reply = sentence.repeat(20);
  const result = speakableSummary({ reply, maxChars: 100 });
  assert.ok(result.length <= 100);
  assert.match(result, /\.$/);
});

test("english text with no Devanagari passes through untouched (aside from markdown/currency)", () => {
  const reply = "Two suits with lining, total four thousand rupees.";
  const result = speakableSummary({ reply });
  assert.equal(result, reply);
});

test("stripSpokenBlock removes the fence but keeps the rest for display", () => {
  const reply = "Here is your answer.\n\n```spoken\nShort version.\n```";
  assert.equal(stripSpokenBlock(reply), "Here is your answer.");
});

test("extractQuoteIdFromReply parses phrase and JSON forms", () => {
  assert.equal(extractQuoteIdFromReply("Saved as quote id 8b1e6e0a-1234-4abc-9def-0123456789ab."), "8b1e6e0a-1234-4abc-9def-0123456789ab");
  assert.equal(extractQuoteIdFromReply('{"id": "8b1e6e0a-1234-4abc-9def-0123456789ab", "totalPaise": 100}'), "8b1e6e0a-1234-4abc-9def-0123456789ab");
  assert.equal(extractQuoteIdFromReply("no id here"), undefined);
});

test("extractQuoteIdFromReply tolerates a backtick-wrapped markdown label", () => {
  const reply = "- Quote ID: `7df0ff17-7f2e-44aa-a78a-5cd8c2ff827e`";
  assert.equal(extractQuoteIdFromReply(reply), "7df0ff17-7f2e-44aa-a78a-5cd8c2ff827e");
});

test("extractQuoteIdFromReply tolerates a bold markdown label with a #Q reference", () => {
  const reply = "**Quotation** #Q: 7df0ff17-7f2e-44aa-a78a-5cd8c2ff827e";
  assert.equal(extractQuoteIdFromReply(reply), "7df0ff17-7f2e-44aa-a78a-5cd8c2ff827e");
});

test("extractQuoteIdFromReply parses the CLI's JSON output shape", () => {
  const reply = 'Created it:\n{\n  "id": "7df0ff17-7f2e-44aa-a78a-5cd8c2ff827e",\n  "totalPaise": 605340\n}';
  assert.equal(extractQuoteIdFromReply(reply), "7df0ff17-7f2e-44aa-a78a-5cd8c2ff827e");
});

test("extractQuoteIdFromReply ignores a conversation id with no quote label", () => {
  const reply = "Conversation id: 3f2504e0-4f89-11d3-9a0c-0305e82c3301. How can I help?";
  assert.equal(extractQuoteIdFromReply(reply), undefined);
});

test("extractQuoteIdFromReply returns the first of two quote ids", () => {
  const reply =
    "Original quote id 8b1e6e0a-1234-4abc-9def-0123456789ab was revised; new quote id 7df0ff17-7f2e-44aa-a78a-5cd8c2ff827e replaces it.";
  assert.equal(extractQuoteIdFromReply(reply), "8b1e6e0a-1234-4abc-9def-0123456789ab");
});
