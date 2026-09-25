import type { TradePack } from "../trade/index.ts";
import type { DesignRecord } from "./store.ts";
import type { DesignService } from "./rag.ts";
import { tokenize, resolveTerm } from "./vocabulary.ts";

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
  /** True when nothing was recognised and Kelly is asking which category the customer meant, instead of showing an unfiltered set. */
  clarify?: boolean;
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

function pluralize(name: string): string {
  return name.endsWith("s") ? name : `${name}s`;
}

/** "a, b, c or d" — the exact join style used in the clarification sentence below. */
function listSentence(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

function clarificationText(pack: TradePack): string {
  return `Which designs would you like to see: ${listSentence(pack.galleryCategories.map(pluralize))}?`;
}

/**
 * Returns `undefined` unless the trade has a gallery AND the prompt is unambiguously a
 * browse request: it names a browse verb, names a known category/tag/latest/trending/
 * designs, carries no pricing/quantity/judgment words, and is short. When it matches, the
 * gallery is queried, the shown designs are marked, and a single-sentence summary is
 * returned for both display and speech. `markShown: false` (the public Explore page) leaves the
 * gallery's shown counts, and so its "trending" order, untouched.
 */
export async function galleryFastPath(prompt: string, pack: TradePack, service: DesignService, options: { markShown?: boolean } = {}): Promise<GalleryFastPathResult | undefined> {
  const markShown = options.markShown !== false;
  if (!pack.galleryCategories.length) return undefined;
  if (prompt.length >= MAX_LEN) return undefined;
  const lower = prompt.toLowerCase();
  if (!BROWSE_VERBS.test(lower)) return undefined;
  if (DISQUALIFIERS.some((word) => lower.includes(word))) return undefined;
  if (QUANTITY_UNIT.test(lower)) return undefined;

  const tokens = tokenize(prompt);
  const vocab = { galleryCategories: pack.galleryCategories, galleryTags: pack.galleryTags, aliases: pack.aliases };

  let category: string | undefined;
  let namesTag = false;
  let trending = false;
  let latest = false;
  for (const token of tokens) {
    const resolved = resolveTerm(token, vocab);
    if (!resolved) continue;
    if (resolved.kind === "category") { category ??= resolved.value; continue; }
    if (resolved.kind === "tag") { namesTag = true; continue; }
    if (resolved.kind === "latest") { latest = true; continue; }
    trending = true;
  }
  // "designs"/"collection"/"options" alone (no recognised category, tag, or latest/trending
  // intent) is an ambiguous browse ask, not a request for an unfiltered, mixed-category set —
  // this is the exact shape of the "Lengar designs" incident this fast path used to mishandle.
  const namesDesignsAsk = tokens.includes("designs") || tokens.includes("collection") || tokens.includes("options");
  if (!category && !namesTag && !trending && !latest) {
    if (!namesDesignsAsk) return undefined;
    const text = clarificationText(pack);
    return { text, spoken: text, designs: [], clarify: true };
  }

  const empty = (): GalleryFastPathResult => ({ text: "No designs in the gallery for that yet.", spoken: "No designs in the gallery for that yet.", designs: [] });

  const results = await service.find(prompt, { limit: 8 });
  if (results.length) {
    if (markShown) service.store.markShown(results.map((design) => design.id));
    const adjective = trending ? "trending " : latest ? "latest " : "";
    const noun = `design${results.length === 1 ? "" : "s"}`;
    const text = category
      ? `Showing ${results.length} ${adjective}${category} ${noun}.`
      : (trending || latest)
        ? `Showing the ${results.length} ${adjective}${noun} across categories.`
        : `Showing ${results.length} ${adjective}${noun}.`;
    return { text, spoken: text, designs: results };
  }

  // A trending ask that comes up empty for a known category widens to the latest of that
  // category rather than reporting nothing, same widening spirit as DesignService.find.
  if (category && trending) {
    const widened = await service.find(category, { category, latest: true, limit: 8 });
    if (widened.length) {
      if (markShown) service.store.markShown(widened.map((design) => design.id));
      const text = `No ${category} designs match trending yet; here are the latest ${category}s.`;
      return { text, spoken: text, designs: widened };
    }
  }

  return empty();
}
