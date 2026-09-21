/**
 * DEVANAGARI → ROMAN HINGLISH — what the owner reads, never what a translator would write.
 *
 * Whisper sometimes writes Hindi words in Devanagari even inside an otherwise Hinglish
 * sentence. The owner's eyes want "mujhe das bulb chahiye", not "मुझे दस बल्ब चाहिए" and not
 * an English translation either — this is a script conversion, not a translation. English
 * loanwords and brand names keep their normal spelling (Havells, ceiling fan) rather than a
 * mechanical transliteration (haivels, siling phain).
 *
 * Deterministic and local: no model, no network call. Three passes, in order:
 *   1. Whole-word dictionary hits (brands, counter loanwords, common Hindi words whose
 *      conventional Hinglish spelling is not what mechanical transliteration would produce).
 *   2. A couple of brand spellings that are written as two tokens or hyphenated in
 *      Devanagari (हिंदी "वी गार्ड"), handled as a literal substring pass before word
 *      splitting so they still hit the dictionary spelling.
 *   3. Whatever Devanagari remains: syllable-by-syllable transliteration (see
 *      `transliterateWord`).
 *
 * Punctuation, digits already in Latin form, and Latin/English text pass through untouched.
 * Pure English input (no Devanagari at all) is returned unchanged by `hasDevanagari`'s guard
 * before any of the above runs.
 */

/** True when `text` contains at least one Devanagari codepoint (U+0900–U+097F, includes the digits). */
export function hasDevanagari(text: string): boolean {
  return /[ऀ-ॿ]/.test(text);
}

/** Brands: same Devanagari spellings as the brand table in transcripts.ts, single-token form. */
const BRAND_WORDS: Record<string, string> = {
  "हैवेल्स": "Havells", "हैवल्स": "Havells",
  "फिलिप्स": "Philips",
  "क्रॉम्पटन": "Crompton", "क्रॉम्प्टन": "Crompton",
  "एंकर": "Anchor", "ऐंकर": "Anchor",
  "पॉलीकैब": "Polycab", "पोलीकैब": "Polycab",
  "फिनोलेक्स": "Finolex",
  "लेग्रैंड": "Legrand", "लेग्रांड": "Legrand",
  "ओरिएंट": "Orient",
  "बजाज": "Bajaj",
  "वीगार्ड": "V-Guard",
  "सिस्का": "Syska",
  "उषा": "Usha",
  "ल्यूमिनस": "Luminous",
  "रैकोल्ड": "Racold",
  "श्नाइडर": "Schneider",
  "सीमेंस": "Siemens",
  "गोल्डमेडल": "Goldmedal",
  "विप्रो": "Wipro",
  "एटमबर्ग": "Atomberg",
};

/** Brand spellings written as two tokens or hyphenated: a literal pass before word splitting. */
const BRAND_PHRASES: Array<[string, string]> = [
  ["वी-गार्ड", "V-Guard"],
  ["वी गार्ड", "V-Guard"],
];

/** Counter loanwords: everyday shop vocabulary kept in its normal English spelling. */
const LOANWORDS: Record<string, string> = {
  "सीलिंग": "ceiling", "फैन": "fan", "कोटेशन": "quotation", "बल्ब": "bulb", "वायर": "wire",
  "स्विच": "switch", "सॉकेट": "socket", "लाइट": "light", "पीस": "piece", "मीटर": "meter",
  "वाट": "watt", "वॉट": "watt", "वोल्ट": "volt", "बैटन": "batten", "स्टेबलाइजर": "stabilizer",
  "एग्जॉस्ट": "exhaust", "स्टॉक": "stock", "पंप": "pump", "केबल": "cable", "हीटर": "heater",
  "गीजर": "geyser", "रेट": "rate", "प्राइस": "price", "एमसीबी": "MCB", "एलईडी": "LED",
  "कंड्यूट": "conduit", "पाइप": "pipe", "बॉक्स": "box", "कॉइल": "coil", "लेंथ": "length",
  "मॉडल": "model", "ब्रांड": "brand",
};

/** Common Hindi words whose conventional Hinglish spelling differs from mechanical transliteration. */
const COMMON_WORDS: Record<string, string> = {
  "है": "hai", "हैं": "hain", "में": "mein", "और": "aur", "क्या": "kya", "कौन": "kaun",
  "नहीं": "nahi", "हाँ": "haan", "वो": "wo", "वाला": "wala", "वाली": "wali", "वाले": "wale",
  "चाहिए": "chahiye", "कीजिए": "kijiye", "दीजिए": "dijiye", "बताइए": "bataiye", "लगा": "laga",
  "भेज": "bhej", "दो": "do", "तीन": "teen", "चार": "char", "पाँच": "paanch", "पांच": "paanch",
  "छह": "chhe", "दस": "das", "बीस": "bees", "पचास": "pachas", "सौ": "sau", "हज़ार": "hazaar",
  "हजार": "hazaar", "लाख": "lakh", "डेढ़": "dedh", "सवा": "sawa", "ढाई": "dhai",
};

/** Office/shop-talk loanwords written in Devanagari but read as their normal English spelling. */
const OFFICE_LOANWORDS: Record<string, string> = {
  "कन्फर्म": "confirm", "कैटलॉग": "catalogue", "पब्लिश": "publish", "अप्रूव": "approve",
  "सप्लायर": "supplier", "कस्टमर": "customer", "ऑर्डर": "order", "इन्वॉइस": "invoice",
  "डिस्काउंट": "discount", "जीएसटी": "GST", "टोटल": "total", "पेमेंट": "payment",
  "डिलीवरी": "delivery", "प्रोडक्ट": "product", "रिव्यू": "review", "अपडेट": "update",
  "मैसेज": "message", "व्हाट्सएप": "WhatsApp", "व्हाट्सऐप": "WhatsApp", "फोन": "phone",
  "नंबर": "number",
};

const WORD_DICTIONARY: Record<string, string> = {
  ...BRAND_WORDS, ...LOANWORDS, ...COMMON_WORDS, ...OFFICE_LOANWORDS,
};

/* ------------------------------------------------------------------ *
 * Syllable-by-syllable transliteration for whatever is not in the
 * dictionary above.
 * ------------------------------------------------------------------ */

const INDEPENDENT_VOWELS: Record<string, string> = {
  "अ": "a", "आ": "a", "इ": "i", "ई": "i", "उ": "u", "ऊ": "u", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au",
  // Candra (nasalized/short) independent vowels used to render English loanword vowels.
  "ऑ": "o", "ऍ": "a", "ऎ": "e", "ऒ": "o",
};

const MATRAS: Record<string, string> = {
  "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ृ": "ri",
  // Candra (nasalized/short) vowel signs used to render English loanword vowels in Devanagari.
  "ॉ": "o", "ॅ": "a", "ॆ": "e", "ॊ": "o",
};

const CONSONANTS: Record<string, string> = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n",
  "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
  "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
  "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
  "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh", "ष": "sh", "स": "s", "ह": "h",
  // precomposed nukta forms
  "क़": "q", "ख़": "kh", "ग़": "g", "ज़": "z", "फ़": "f", "ड़": "r", "ढ़": "rh",
};

/** Base consonant + combining nukta (U+093C) as two codepoints, rather than the precomposed form above. */
const NUKTA_COMBINING: Record<string, string> = {
  "क़": "q", "ख़": "kh", "ग़": "g", "ज़": "z", "फ़": "f", "ड़": "r", "ढ़": "rh",
};

/** Checked before generic consonant-by-consonant processing: whole conjunct clusters with a fixed reading. */
const CONJUNCTS: Record<string, string> = {
  "ज्ञ": "gy", "क्ष": "ksh", "त्र": "tr", "श्र": "shr",
};

const VIRAMA = "्";
const NUKTA = "़";
const ANUSVARA = "ं";
const CHANDRABINDU = "ँ";
const VISARGA = "ः";
const LABIALS = new Set(["प", "फ", "ब", "भ", "म"]);

function digitValue(ch: string): string | undefined {
  const code = ch.codePointAt(0);
  if (code === undefined) return undefined;
  return code >= 0x0966 && code <= 0x096f ? String(code - 0x0966) : undefined;
}

/** Consonants whose inherent "a", once dropped word-finally, reads naturally with a doubled vowel. */
const DOUBLING_FINALS = new Set(["न", "म", "ल", "र"]);

/** One transliterated chunk of a word: a syllable nucleus (vowel-bearing) or a non-syllabic token. */
interface Group {
  /** Roman text for the consonant(s)/letter(s), not including the vowel suffix. */
  roman: string;
  /** Vowel suffix appended after `roman` (e.g. "a", "i", "aa", "an", "ah"); "" once deleted/absent. */
  vowelRoman: string;
  /** True for a syllable that still carries a vowel and participates in medial schwa-deletion. */
  carriesVowel: boolean;
  /** True only for a plain, still-undeleted inherent "a" (eligible for medial schwa deletion). */
  deletableInherent: boolean;
  /** Devanagari consonant-letter count of this group (prefix cluster + core), for the 3-consonant guard. */
  letterCount: number;
}

function pushGroup(groups: Group[], roman: string, vowelRoman: string, carriesVowel: boolean, deletableInherent: boolean, letterCount: number): void {
  groups.push({ roman, vowelRoman, carriesVowel, deletableInherent, letterCount });
}

/**
 * Tokenizes one Devanagari "word" (a contiguous run with no dictionary hit) into syllable-ish
 * groups, character by character. Consonants carry an inherent "a" unless a vowel sign or virama
 * follows; the inherent "a" is dropped at the end of the word (the last consonant of the run,
 * with nothing — not even an anusvara/visarga — after it). A leading long आ matra doubles to
 * "aa" when the whole word is just that consonant plus one more, word-final न/म/ल/र (मान -> maan).
 */
function tokenizeWord(word: string): Group[] {
  const groups: Group[] = [];
  let i = 0;
  const n = word.length;
  let prefixRoman = "";
  let prefixLetters = 0;

  while (i < n) {
    const three = word.slice(i, i + 3);
    if (CONJUNCTS[three]) {
      pushGroup(groups, prefixRoman + CONJUNCTS[three], "", false, false, prefixLetters + 2);
      prefixRoman = ""; prefixLetters = 0;
      i += 3; continue;
    }

    const ch = word[i];
    const digit = digitValue(ch);
    if (digit !== undefined) { pushGroup(groups, digit, "", false, false, 0); i += 1; continue; }

    if (INDEPENDENT_VOWELS[ch] !== undefined) {
      pushGroup(groups, prefixRoman + INDEPENDENT_VOWELS[ch], "", true, false, 0);
      prefixRoman = ""; prefixLetters = 0;
      i += 1; continue;
    }

    const consBase = CONSONANTS[ch];
    if (consBase !== undefined) {
      let idx = i + 1;
      let consRoman = consBase;
      if (word[idx] === NUKTA) {
        const combined = NUKTA_COMBINING[ch + NUKTA];
        if (combined) consRoman = combined;
        idx += 1;
      }
      if (word[idx] === VIRAMA) {
        // Mid-word conjunct onset: no vowel of its own, glues onto the next consonant's syllable.
        prefixRoman += consRoman; prefixLetters += 1;
        i = idx + 1; continue;
      }

      const isFirstGroup = groups.length === 0 && prefixLetters === 0;
      const matra = word[idx] !== undefined ? MATRAS[word[idx]] : undefined;
      if (matra !== undefined) {
        if (word[idx] === "ा" && isFirstGroup) {
          const rest = word.slice(idx + 1);
          if (rest.length === 1 && DOUBLING_FINALS.has(rest)) {
            pushGroup(groups, prefixRoman + consRoman, "aa", true, false, prefixLetters + 1);
            prefixRoman = ""; prefixLetters = 0;
            i = idx + 1; continue;
          }
        }
        pushGroup(groups, prefixRoman + consRoman, matra, true, false, prefixLetters + 1);
        prefixRoman = ""; prefixLetters = 0;
        i = idx + 1; continue;
      }
      if (word[idx] === ANUSVARA) {
        const labial = LABIALS.has(word[idx + 1] ?? "");
        pushGroup(groups, prefixRoman + consRoman, `a${labial ? "m" : "n"}`, true, false, prefixLetters + 1);
        prefixRoman = ""; prefixLetters = 0;
        i = idx + 1; continue;
      }
      if (word[idx] === CHANDRABINDU) {
        pushGroup(groups, prefixRoman + consRoman, "an", true, false, prefixLetters + 1);
        prefixRoman = ""; prefixLetters = 0;
        i = idx + 1; continue;
      }
      if (word[idx] === VISARGA) {
        pushGroup(groups, prefixRoman + consRoman, "ah", true, false, prefixLetters + 1);
        prefixRoman = ""; prefixLetters = 0;
        i = idx + 1; continue;
      }
      // Nothing follows this consonant inside the word: drop the inherent "a".
      const isWordFinal = idx >= n;
      pushGroup(groups, prefixRoman + consRoman, isWordFinal ? "" : "a", !isWordFinal, !isWordFinal, prefixLetters + 1);
      prefixRoman = ""; prefixLetters = 0;
      i = idx; continue;
    }

    if (ch === ANUSVARA) { pushGroup(groups, "n", "", false, false, 0); i += 1; continue; }
    if (ch === CHANDRABINDU) { pushGroup(groups, "n", "", false, false, 0); i += 1; continue; }
    if (ch === VISARGA) { pushGroup(groups, "h", "", false, false, 0); i += 1; continue; }
    if (ch === VIRAMA || ch === NUKTA) { i += 1; continue; } // stray marks with nothing to attach to

    // Anything else Devanagari that is not covered above (rare punctuation, etc.) passes through.
    pushGroup(groups, ch, "", false, false, 0);
    i += 1;
  }
  return groups;
}

/**
 * Standard Hindi medial schwa (inherent "a") deletion: in a word of three or more syllables, a
 * non-first, non-last consonant's inherent "a" drops when the syllable after it still carries a
 * vowel. Processed right-to-left so a deletion cannot cascade into its left neighbour, which also
 * guarantees the "no three consonants in a row" guard below never needs to look more than one
 * syllable ahead.
 */
function applyMedialSchwaDeletion(groups: Group[]): void {
  const nucleus = groups.filter((g) => g.carriesVowel);
  if (nucleus.length < 3) return;
  for (let idx = nucleus.length - 2; idx >= 1; idx -= 1) {
    const g = nucleus[idx];
    if (!g.deletableInherent) continue;
    // The preceding syllable is always still untouched (and so still carries a vowel) here,
    // since we walk right-to-left; only the following syllable can already be dead.
    const next = nucleus[idx + 1];
    if (next.vowelRoman === "") continue;
    const consonantRun = g.letterCount + next.letterCount;
    if (consonantRun >= 3) continue; // would create three consonants in a row
    g.vowelRoman = "";
    g.deletableInherent = false;
  }
}

function renderGroups(groups: Group[]): string {
  return groups.map((g) => g.roman + g.vowelRoman).join("");
}

function transliterateWord(word: string): string {
  const groups = tokenizeWord(word);
  applyMedialSchwaDeletion(groups);
  return renderGroups(groups);
}

/**
 * Converts Devanagari inside `text` to Roman Hinglish. Pure English/Latin text is returned
 * unchanged. English loanwords and brand names spoken in Devanagari come back in their normal
 * spelling; everything else is either a dictionary hit or a syllable-by-syllable fallback.
 */
export function toRomanHinglish(text: string): string {
  if (!hasDevanagari(text)) return text;

  let working = text;
  for (const [phrase, roman] of BRAND_PHRASES) working = working.split(phrase).join(roman);

  const parts = working.match(/[ऀ-ॿ]+|[^ऀ-ॿ]+/g) ?? [working];
  return parts.map((part) => {
    if (!hasDevanagari(part)) return part;
    const hit = WORD_DICTIONARY[part];
    if (hit !== undefined) return hit;
    return transliterateWord(part);
  }).join("");
}
