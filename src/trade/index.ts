/**
 * Trade packs: a fixed-per-install configuration that shapes Kelly's prompt,
 * intake questions, and gallery taxonomy for one line of business. The trade
 * is chosen once at setup (KELLY_TRADE) and does not switch at runtime.
 */
import { electricalTradePack } from "./electrical.ts";
import { boutiqueTradePack } from "./boutique.ts";

export type TradeId = "electrical" | "boutique";

export interface TradePack {
  id: TradeId;
  displayName: string;
  defaultShopName: string;
  /** "product" | "service" */
  lineNoun: string;
  /** "catalogue" | "rate card" */
  catalogueNoun: string;
  brandRequired: boolean;
  accent: { copper: string; copper2: string; dim: string };
  promptBlock: string;
  /** Fields Kelly must know before pricing. */
  quoteIntake: string[];
  galleryCategories: string[];
  galleryTags: string[];
  setupQuestions: string[];
}

const PACKS: Record<TradeId, TradePack> = {
  electrical: electricalTradePack,
  boutique: boutiqueTradePack,
};

export function tradePack(id: TradeId): TradePack {
  return PACKS[id];
}

/** Defaults to "electrical" when unset; throws on any other unknown non-empty value. */
export function parseTradeId(value: unknown): TradeId {
  if (value === undefined || value === null || value === "") return "electrical";
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "") return "electrical";
  if (normalized === "electrical" || normalized === "boutique") return normalized;
  const valid = Object.keys(PACKS).join(", ");
  throw new Error(`Unknown trade "${value}". Valid trades: ${valid}.`);
}

export { electricalTradePack, boutiqueTradePack };
