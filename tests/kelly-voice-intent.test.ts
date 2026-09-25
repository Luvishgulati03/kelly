import test from "node:test";
import assert from "node:assert/strict";
import { isLookupRequest } from "../src/voice/intent.ts";
import { boutiqueTradePack, electricalTradePack } from "../src/trade/index.ts";

/**
 * isLookupRequest decides whether a Talk turn earns the holding phrase ("Please wait a few
 * moments while I gather the information you need."). Small talk never does; a price,
 * quotation or show-me request does.
 */

const SMALL_TALK = [
  "thank you, bye",
  "hello",
  "hi",
  "namaste",
  "namaste ji",
  "bye",
  "goodbye",
  "alvida",
  "thanks",
  "thank you",
  "shukriya",
  "dhanyavad",
  "ok",
  "okay",
  "theek hai",
  "accha",
  "kaise ho",
  "how are you",
  "who are you",
  "thanks a lot, have a good day",
  "good morning",
  "see you later",
  "I will sit down and wait",
  "happy new year",
  "do you have time",
  // Long small talk is still small talk.
  "Thank you so much, you have been very helpful today, I will come back tomorrow with my sister and my mother, okay, bye bye",
  "",
];

const BOUTIQUE_LOOKUPS = [
  "lehenga designs",
  "lehinga designs",
  "show me sarees",
  "kitne ka padega",
  "2 suits with lining price",
  "quote 10 MCB",
  "दिखाओ",
  "कितना",
  "thanks, and how much for 2 suits?",
  "do suit",
  "bridal collection",
  "डिज़ाइन दिखाइए",
  "\u0921\u093F\u095B\u093E\u0907\u0928", // डिज़ाइन spelled with the precomposed nukta letter U+095B
  "\u0921\u093F\u091C\u093C\u093E\u0907\u0928", // the same word with a combining nukta
  "blouse ki silai kitni hai",
  "सिलाई",
  "what is on the rate card",
  "stitching charge for a kurti",
  "rate kya hai",
  "₹500 mein kya milega",
  "any latest options",
  "trending",
  "I want 3 metres",
  "estimate with GST",
  "gown",
  "salwar",
  "कीमत बताइए",
];

test("small talk, greetings, thanks and goodbyes are never a lookup (boutique and electrical)", () => {
  for (const phrase of SMALL_TALK) {
    assert.equal(isLookupRequest(phrase, boutiqueTradePack), false, `boutique: "${phrase}" should not be a lookup`);
    assert.equal(isLookupRequest(phrase, electricalTradePack), false, `electrical: "${phrase}" should not be a lookup`);
  }
});

test("price, quotation and show-me requests are lookups on the boutique pack", () => {
  for (const phrase of BOUTIQUE_LOOKUPS) {
    assert.equal(isLookupRequest(phrase, boutiqueTradePack), true, `boutique: "${phrase}" should be a lookup`);
  }
});

test("electrical pack: price words, catalogue noun and quantity with a catalogue word are lookups; garment words are not", () => {
  assert.equal(isLookupRequest("quote 10 MCB", electricalTradePack), true);
  assert.equal(isLookupRequest("10 MCB", electricalTradePack), true, "digit + pack vocabulary word");
  assert.equal(isLookupRequest("das switch", electricalTradePack), true, "Hinglish number + pack vocabulary word");
  assert.equal(isLookupRequest("5 coils of wire", electricalTradePack), true);
  assert.equal(isLookupRequest("show me the catalogue", electricalTradePack), true);
  assert.equal(isLookupRequest("Havells fan kitne ka hai", electricalTradePack), true);
  // The electrical pack has no gallery, so a garment word alone is not a pack term there.
  assert.equal(isLookupRequest("do suit", electricalTradePack), false);
  assert.equal(isLookupRequest("lehenga", electricalTradePack), false);
});

test("mixed small talk plus a real ask is a lookup", () => {
  assert.equal(isLookupRequest("thanks, and how much for 2 suits?", boutiqueTradePack), true);
  assert.equal(isLookupRequest("namaste, lehenga dikhao", boutiqueTradePack), true);
  assert.equal(isLookupRequest("ok bye, but first the total please", boutiqueTradePack), true);
});

test("the classifier is deterministic", () => {
  for (const phrase of [...SMALL_TALK, ...BOUTIQUE_LOOKUPS]) {
    assert.equal(isLookupRequest(phrase, boutiqueTradePack), isLookupRequest(phrase, boutiqueTradePack));
  }
});

test("occasion words and 'available' in a goodbye stay small talk; with a design or price word they count", () => {
  const boutique = boutiqueTradePack;
  for (const phrase of ["I'm going to a wedding, bye", "are you available?", "party tonight, see you", "show must go on, bye"]) {
    assert.equal(isLookupRequest(phrase, boutique), false, phrase);
  }
  for (const phrase of ["wedding designs please", "2 party wear suits", "show me sarees", "bridal lehenga dikhao"]) {
    assert.equal(isLookupRequest(phrase, boutique), true, phrase);
  }
});
