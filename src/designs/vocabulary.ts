import type { TradePack } from "../trade/index.ts";

/**
 * Shared vocabulary resolution for the design gallery: turns a raw spoken/typed token into
 * a recognised category, tag, or latest/trending intent, using the trade pack's own alias
 * table (misspellings, Hinglish, Devanagari) plus a narrow fuzzy match for garment words
 * whisper.cpp mis-heard (see the "Lengar"/"lehinga" incident this module exists to fix).
 *
 * Deliberately conservative: nothing here ever invents a category the pack does not declare,
 * and the fuzzy match never runs on 3-letter tokens (too easy to collide with an unrelated
 * short word) or against Devanagari aliases (those are matched exactly; fuzzing a script with
 * no whisper-cpp misspelling risk would only add false positives).
 */

export type VocabularyPack = Pick<TradePack, "galleryCategories" | "galleryTags" | "aliases">;

export interface ResolvedTerm {
  kind: "category" | "tag" | "latest" | "trending";
  value: string;
}

const LATIN_TOKEN = /[a-z][a-z-]*/g;
const DEVANAGARI_TOKEN = /[ऀ-ॿ]+/g;

/** Latin words (lower-cased) and Devanagari words, in the order they were matched. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const latin = text.toLowerCase().match(LATIN_TOKEN);
  if (latin) tokens.push(...latin);
  const devanagari = text.match(DEVANAGARI_TOKEN);
  if (devanagari) tokens.push(...devanagari);
  return tokens;
}

function singularOf(word: string): string {
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

const LATEST_WORDS = new Set(["latest", "newest", "recent", "new"]);
const TRENDING_WORDS = new Set(["trending", "popular"]);

/** Restricted (optimal string alignment) Damerau-Levenshtein distance: insert/delete/substitute/transpose. */
function editDistance(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const d: number[][] = Array.from({ length: al + 1 }, () => new Array<number>(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) d[i][0] = i;
  for (let j = 0; j <= bl; j++) d[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }
  return d[al][bl];
}

function kindOf(key: string, pack: VocabularyPack): ResolvedTerm["kind"] | undefined {
  // Same intent-first priority as resolveTerm: "latest"/"trending" never resolve as a plain tag.
  if (key === "latest") return "latest";
  if (key === "trending") return "trending";
  if (pack.galleryCategories.includes(key)) return "category";
  if (pack.galleryTags.includes(key)) return "tag";
  return undefined;
}

const ONLY_LATIN = /^[a-z][a-z -]*$/i;

/**
 * Resolves one token (Latin or Devanagari) against the pack: exact category/tag name,
 * singular/plural, the literal latest/trending words, the pack's alias table (any script),
 * and — only for 4+ letter Latin tokens — a fuzzy match (distance <= 1 for 4-5 letters,
 * <= 2 for 6+ letters) against category/tag names and the pack's Latin aliases.
 */
export function resolveTerm(token: string, pack: VocabularyPack): ResolvedTerm | undefined {
  // "latest"/"trending" are read as intent even when the pack also uses them as literal tag
  // names on a design row (both boutique packs do) — a query word always means the intent.
  if (LATEST_WORDS.has(token)) return { kind: "latest", value: "latest" };
  if (TRENDING_WORDS.has(token)) return { kind: "trending", value: "trending" };

  const candidates = [token, singularOf(token)];
  for (const candidate of candidates) {
    if (pack.galleryCategories.includes(candidate)) return { kind: "category", value: candidate };
    if (pack.galleryTags.includes(candidate)) return { kind: "tag", value: candidate };
  }

  const aliases = pack.aliases ?? {};
  for (const [key, variants] of Object.entries(aliases)) {
    const kind = kindOf(key, pack);
    if (!kind) continue;
    const lowerVariants = variants.map((variant) => variant.toLowerCase());
    if (candidates.some((candidate) => lowerVariants.includes(candidate))) return { kind, value: key };
  }

  // Fuzzy match is Latin-only and never runs on 3-letter (or shorter) tokens.
  if (ONLY_LATIN.test(token) && token.length >= 4) {
    const maxDistance = token.length <= 5 ? 1 : 2;
    for (const name of [...pack.galleryCategories, ...pack.galleryTags]) {
      if (editDistance(token, name) <= maxDistance) return { kind: kindOf(name, pack)!, value: name };
    }
    for (const [key, variants] of Object.entries(aliases)) {
      const kind = kindOf(key, pack);
      if (!kind) continue;
      for (const variant of variants) {
        if (!ONLY_LATIN.test(variant)) continue;
        if (editDistance(token, variant.toLowerCase()) <= maxDistance) return { kind, value: key };
      }
    }
  }
  return undefined;
}

/** True when the token resolves to any known category, tag, or latest/trending intent. */
export function recognisedGarmentWord(token: string, pack: VocabularyPack): boolean {
  return resolveTerm(token, pack) !== undefined;
}

/** "<shop name>: word, word, ..." for whisper.cpp's --prompt vocabulary hint, or undefined when the pack carries no vocabulary. */
export function voicePrompt(shopName: string, vocabulary: string[]): string | undefined {
  if (!vocabulary.length) return undefined;
  return `${shopName}: ${vocabulary.join(", ")}`;
}
