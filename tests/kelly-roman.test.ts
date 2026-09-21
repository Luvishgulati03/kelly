import { test } from "node:test";
import assert from "node:assert/strict";
import { hasDevanagari, toRomanHinglish } from "../src/voice/roman.ts";

/**
 * ROMAN HINGLISH — the owner always reads Roman script, English/brand spellings kept as-is,
 * never a translation. See src/voice/roman.ts for the pass order.
 */

test("pure English passes through untouched", () => {
  assert.equal(hasDevanagari("Polycab ka 1.5 sq mm wire, 100 m coil ka rate"), false);
  assert.equal(toRomanHinglish("Polycab ka 1.5 sq mm wire, 100 m coil ka rate"), "Polycab ka 1.5 sq mm wire, 100 m coil ka rate");
});

test("required case: numbers and a loanword", () => {
  assert.equal(toRomanHinglish("मुझे दस बल्ब चाहिए"), "mujhe das bulb chahiye");
});

test("required case: brand, counter loanwords and a verb", () => {
  assert.equal(toRomanHinglish("हैवेल्स के दो सीलिंग फैन का कोटेशन बना दो"), "Havells ke do ceiling fan ka quotation bana do");
});

test("required case: mixed English sentence with a Devanagari tail", () => {
  assert.equal(toRomanHinglish("the customer wants दो पंखे"), "the customer wants do pankhe");
});

test("required case: pure Latin/English is never touched", () => {
  const text = "Polycab ka 1.5 sq mm wire, 100 m coil ka rate";
  assert.equal(toRomanHinglish(text), text);
});

test("required case: brand plus loanwords plus common words", () => {
  assert.equal(toRomanHinglish("क्रॉम्पटन का कौन सा एग्जॉस्ट फैन स्टॉक में है"), "Crompton ka kaun sa exhaust fan stock mein hai");
});

test("required case: demonstrative + loanword + number + verb", () => {
  assert.equal(toRomanHinglish("वो वाली लाइट चार पीस भेज दो"), "wo wali light char piece bhej do");
});

test("required case: fractional numbers and loanwords", () => {
  assert.equal(toRomanHinglish("डेढ़ सौ स्विच और सवा सौ सॉकेट का रेट बता दो"), "dedh sau switch aur sawa sau socket ka rate bata do");
});

test("required case: Devanagari digit plus a unit loanword", () => {
  assert.equal(toRomanHinglish("२० वाट"), "20 watt");
});

test("hasDevanagari is true only when a Devanagari codepoint is present", () => {
  assert.equal(hasDevanagari("hello"), false);
  assert.equal(hasDevanagari("नमस्ते"), true);
  assert.equal(hasDevanagari("२०"), true);
});

/* ------------------------------------------------------------------ *
 * A few of our own, exercising the generic syllable engine and other
 * brand/loanword dictionary hits.
 * ------------------------------------------------------------------ */

test("generic transliteration: word-final schwa is dropped", () => {
  // नमस्ते = न + म + स + ् + त + े -> "nam" + "ste" (no trailing vowel after "namaste" 'e' is explicit)
  assert.equal(toRomanHinglish("नमस्ते"), "namaste");
});

test("generic transliteration: mid-word consonant keeps its inherent a, anusvara nasal picks m/n correctly", () => {
  assert.equal(toRomanHinglish("संदेश"), "sandesh"); // स + ं(anusvara before द, non-labial -> n) + द + े + श
  assert.equal(toRomanHinglish("कंबल"), "kambal"); // क + ं (anusvara before ब, labial -> m) + ब + ल
});

test("another brand and loanword sentence", () => {
  assert.equal(toRomanHinglish("फिलिप्स का एलईडी बल्ब चाहिए"), "Philips ka LED bulb chahiye");
});

test("V-Guard hyphenated and spaced Devanagari spellings both resolve", () => {
  assert.equal(toRomanHinglish("वी-गार्ड का पंप"), "V-Guard ka pump");
  assert.equal(toRomanHinglish("वी गार्ड का पंप"), "V-Guard ka pump");
});

/* ------------------------------------------------------------------ *
 * Spot-check fixes: candra vowel signs, office loanwords, medial schwa
 * deletion, and the मान/माल long-आ doubling.
 * ------------------------------------------------------------------ */

test("no Devanagari codepoint ever leaks into the output", () => {
  const inputs = [
    "इसको कन्फर्म मान लो और कैटलॉग पब्लिश कर दो",
    "कस्टमर को व्हाट्सएप पर इन्वॉइस भेज दो",
    "समझना मुश्किल है",
    "कमरा",
    "साहब का ऑर्डर और डिस्काउंट",
    "मुझे दस बल्ब चाहिए",
  ];
  for (const input of inputs) {
    assert.equal(/[ऀ-ॿ]/.test(toRomanHinglish(input)), false, `leaked Devanagari in: ${toRomanHinglish(input)}`);
  }
});

test("required case: candra vowel signs, office loanwords, and medial schwa deletion", () => {
  assert.equal(
    toRomanHinglish("इसको कन्फर्म मान लो और कैटलॉग पब्लिश कर दो"),
    "isko confirm maan lo aur catalogue publish kar do",
  );
});

test("required case: office loanwords including WhatsApp and invoice", () => {
  assert.equal(
    toRomanHinglish("कस्टमर को व्हाट्सएप पर इन्वॉइस भेज दो"),
    "customer ko WhatsApp par invoice bhej do",
  );
});

test("required case: medial schwa deletion in a three-syllable word", () => {
  assert.equal(toRomanHinglish("समझना मुश्किल है"), "samajhna mushkil hai");
});

test("required case: medial schwa deletion, कमरा -> kamra", () => {
  assert.equal(toRomanHinglish("कमरा"), "kamra");
});

test("medial schwa deletion does not touch two-syllable words", () => {
  assert.equal(toRomanHinglish("बना"), "bana");
  assert.equal(toRomanHinglish("कर"), "kar");
});

test("medial schwa deletion never creates three consonants in a row", () => {
  assert.equal(toRomanHinglish("नमस्ते"), "namaste");
});

test("long आ doubles before a word-final न/म/ल/र in a two-syllable word", () => {
  assert.equal(toRomanHinglish("मान"), "maan");
  assert.equal(toRomanHinglish("माल"), "maal");
  assert.equal(toRomanHinglish("राम"), "raam");
  assert.equal(toRomanHinglish("साल"), "saal");
});

test("long आ doubling does not apply to dictionary words or unrelated finals", () => {
  assert.equal(toRomanHinglish("चार"), "char"); // dictionary word, stays as-is
  assert.equal(toRomanHinglish("बना"), "bana"); // final vowel is not न/म/ल/र after ा
  assert.equal(toRomanHinglish("साहब"), "sahab"); // unaffected, two syllables, no medial deletion
});
