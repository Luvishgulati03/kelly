import type { TradePack } from "../trade/index.ts";
import type { DesignRecord } from "../designs/store.ts";
import type { DesignService } from "../designs/rag.ts";
import { resolveTerm, tokenize } from "../designs/vocabulary.ts";

/**
 * SERVER-SIDE DESIGN LOOKUP for a public model turn (boutique-style trades with a gallery).
 *
 * The gallery fast path (src/designs/fastpath.ts) answers only a plain browse ask ("show me silk
 * sarees"): it needs a browse verb. Any other wording that names a garment ("Do you have silk
 * sarees?", "koi bridal lehenga hai?") goes to the model, which has no tools, so without this
 * lookup it saw only the stitching rate card and answered that the shop had none. Here the server
 * reads the gallery in code (read-only: no shown count changes), hands the matching rows to the
 * model as quoted data, and the surface shows the same photos to the visitor.
 */

export interface PublicDesignContext {
  /** The prompt block (empty when the message names no gallery category or tag). */
  block: string;
  designs: DesignRecord[];
}

/** Conversational words that carry no design meaning; left in, they would narrow captions. */
const FILLER = new Set([
  "do", "does", "you", "your", "have", "has", "got", "any", "there", "is", "are", "what", "which", "can", "could",
  "i", "we", "get", "find", "available", "kya", "hai", "hain", "koi", "aapke", "aap", "paas", "milega", "milegi",
  "mil", "sakta", "sakti", "chahiye", "mujhe", "batao", "dikhao", "show", "me", "some", "please", "the", "a", "an",
]);

const MAX_DESIGNS = 8;

function clean(value: string, max = 120): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/</g, "‹").replace(/>/g, "›").trim().slice(0, max);
}

function designLine(design: DesignRecord): string {
  const parts = [
    clean(design.caption || design.category),
    `category ${clean(design.category, 40)}`,
    ...(design.fabric ? [`fabric ${clean(design.fabric, 40)}`] : []),
    ...(design.occasion ? [`occasion ${clean(design.occasion, 40)}`] : []),
    ...(design.colours.length ? [`colours ${clean(design.colours.join(", "), 60)}`] : []),
    ...(design.priceBand ? [`price band ${clean(design.priceBand, 40)}`] : []),
  ];
  return `- ${parts.join(" | ")}`;
}

/**
 * The design block for one public turn, or an empty one when the message names no gallery
 * category or tag (an electrical shop, or a question about stitching rates alone).
 */
export async function publicDesignContext(service: DesignService | undefined, pack: TradePack, message: string): Promise<PublicDesignContext> {
  if (!service || !pack.galleryCategories.length) return { block: "", designs: [] };
  const vocab = { galleryCategories: pack.galleryCategories, galleryTags: pack.galleryTags, aliases: pack.aliases };
  const tokens = tokenize(message);
  const named = tokens.map((token) => resolveTerm(token, vocab)).filter((term) => term && (term.kind === "category" || term.kind === "tag"));
  if (!named.length) return { block: "", designs: [] };
  const query = tokens.filter((token) => !FILLER.has(token)).join(" ");
  const designs = (await service.find(query, { limit: MAX_DESIGNS })).filter((design) => design.status === "active").slice(0, MAX_DESIGNS);
  const lines = [
    "<shop_designs>",
    "Designs from the shop's own photo gallery that match this message, looked up by the server. The visitor is shown these photos with your reply. They answer whether the shop has such a design; describe them only from these rows. A price band is the shop's rough guide, not a quotation.",
    ...(designs.length ? designs.map(designLine) : ["No design in the gallery matched this message. Say the gallery has no photo of that yet; do not claim the shop cannot make it."]),
    "</shop_designs>",
  ];
  return { block: lines.join("\n"), designs };
}
