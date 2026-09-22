import type { TradePack } from "../trade/index.ts";
import type { DesignRecord } from "./store.ts";
import type { DesignService } from "./rag.ts";

/**
 * Provider-free reflex lane for the design gallery, same precedent as src/reflex.ts:
 * keep the vocabulary narrow, only answer requests with a complete, unambiguous answer
 * in Henry's local state (the gallery itself). Anything that needs pricing, quantity,
 * or judgment belongs to the configured model, so this returns `undefined` and the
 * caller falls through to the normal provider turn.
 */
export interface GalleryFastPathResult {
  text: string;
  spoken: string;
  designs: DesignRecord[];
}

const BROWSE_VERBS = /\b(show|see|dikhao|dikha|view|display|latest|trending|designs|collection|options)\b/i;

const DISQUALIFIERS = [
  "price", "rate", "cost", "how much", "kitna", "quote", "quotation", "stitch",
  "measurement", "order", "book", "cheaper", "compare", "which one", "suggest", "recommend",
];

// A digit run immediately followed by a unit word ("2 metres", "3m", "5 yards") means the
// customer is talking quantity, not browsing — never a fast-path match.
const QUANTITY_UNIT = /\d+\s*(mm|cm|m|meters?|metres?|yards?|yds?|inch(?:es)?|ft|feet|kg|gram?s?|g|pcs?|pieces?)\b/i;

const MAX_LEN = 120;

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z][a-z-]*/g) ?? [];
}

function matchesCategory(word: string, categoryNames: string[]): string | undefined {
  const singular = word.endsWith("s") ? word.slice(0, -1) : word;
  if (categoryNames.includes(word)) return word;
  if (categoryNames.includes(singular)) return singular;
  return undefined;
}

/**
 * Returns `undefined` unless the trade has a gallery AND the prompt is unambiguously a
 * browse request: it names a browse verb, names a known category/tag/latest/trending/
 * designs, carries no pricing/quantity/judgment words, and is short. When it matches, the
 * gallery is queried, the shown designs are marked, and a single-sentence summary is
 * returned for both display and speech.
 */
export async function galleryFastPath(prompt: string, pack: TradePack, service: DesignService): Promise<GalleryFastPathResult | undefined> {
  if (!pack.galleryCategories.length) return undefined;
  if (prompt.length >= MAX_LEN) return undefined;
  const lower = prompt.toLowerCase();
  if (!BROWSE_VERBS.test(lower)) return undefined;
  if (DISQUALIFIERS.some((word) => lower.includes(word))) return undefined;
  if (QUANTITY_UNIT.test(lower)) return undefined;

  const categoryNames = service.store.categoryNames;
  const tagNames = service.store.tagNames;
  const tokens = words(lower);

  let category: string | undefined;
  let namesTag = false;
  for (const token of tokens) {
    if (!category) {
      const hit = matchesCategory(token, categoryNames);
      if (hit) category = hit;
    }
    if (!namesTag && tagNames.includes(token)) namesTag = true;
  }
  const trending = tokens.includes("trending");
  const latest = tokens.includes("latest");
  const namesDesigns = tokens.includes("designs");
  if (!category && !namesTag && !trending && !latest && !namesDesigns) return undefined;

  const empty = (): GalleryFastPathResult => ({ text: "No designs in the gallery for that yet.", spoken: "No designs in the gallery for that yet.", designs: [] });

  const results = await service.find(prompt, { limit: 8 });
  if (results.length) {
    service.store.markShown(results.map((design) => design.id));
    const adjective = trending ? "trending " : latest ? "latest " : "";
    const categoryWord = category ? `${category} ` : "";
    const noun = `design${results.length === 1 ? "" : "s"}`;
    const text = `Showing ${results.length} ${adjective}${categoryWord}${noun}.`;
    return { text, spoken: text, designs: results };
  }

  // A trending ask that comes up empty for a known category widens to the latest of that
  // category rather than reporting nothing, same widening spirit as DesignService.find.
  if (category && trending) {
    const widened = await service.find(category, { category, latest: true, limit: 8 });
    if (widened.length) {
      service.store.markShown(widened.map((design) => design.id));
      const text = `No ${category} designs match trending yet; here are the latest ${category}s.`;
      return { text, spoken: text, designs: widened };
    }
  }

  return empty();
}
