import type { DesignService } from "./rag.ts";
import { encodeSolidPng, type RGB } from "./png.ts";

/**
 * Demo seed: 14 placeholder PNGs (plain colour blocks, named by category) across the seven
 * boutique gallery categories, with mixed tags, so a fresh `kelly start --demo --trade
 * boutique` gallery is testable immediately. Only runs when the store is empty; safe to call
 * on every boot.
 */
const PALETTE: RGB[] = [
  { r: 200, g: 107, b: 133 }, // boutique copper-pink accent
  { r: 240, g: 163, b: 184 },
  { r: 120, g: 76, b: 96 },
  { r: 214, g: 178, b: 122 },
  { r: 96, g: 120, b: 140 },
  { r: 176, g: 140, b: 200 },
  { r: 90, g: 150, b: 130 },
];

const SEED_PLAN: Array<{ category: string; caption: string; tags: string[] }> = [
  { category: "suit", caption: "Straight-cut party suit, gold thread work", tags: ["trending", "party"] },
  { category: "suit", caption: "Everyday cotton suit set", tags: ["casual"] },
  { category: "saree", caption: "Banarasi silk saree, festive drape", tags: ["festive", "trending"] },
  { category: "saree", caption: "Pastel georgette saree", tags: ["latest"] },
  { category: "lehenga", caption: "Bridal lehenga, heavy hand work", tags: ["bridal", "trending"] },
  { category: "lehenga", caption: "Light lehenga for sangeet", tags: ["party", "latest"] },
  { category: "blouse", caption: "Designer blouse, mirror work", tags: ["trending", "custom-order"] },
  { category: "blouse", caption: "Plain fitted blouse", tags: ["casual"] },
  { category: "kurti", caption: "Printed cotton kurti", tags: ["casual", "latest"] },
  { category: "kurti", caption: "Embroidered festive kurti", tags: ["festive"] },
  { category: "gown", caption: "Evening gown, sequin finish", tags: ["party", "trending"] },
  { category: "gown", caption: "Simple A-line gown", tags: ["latest"] },
  { category: "dupatta", caption: "Chiffon dupatta, zari border", tags: ["festive"] },
  { category: "dupatta", caption: "Plain cotton dupatta", tags: ["casual"] },
];

export async function seedBoutiqueDesigns(service: DesignService): Promise<{ seeded: number } | { seeded: 0 }> {
  const existing = service.store.stats();
  if (existing.total > 0) return { seeded: 0 };
  let seeded = 0;
  for (let i = 0; i < SEED_PLAN.length; i++) {
    const plan = SEED_PLAN[i];
    const colour = PALETTE[i % PALETTE.length];
    const accent = PALETTE[(i + 3) % PALETTE.length];
    const bytes = encodeSolidPng(480, 600, colour, accent);
    const result = service.store.add({ bytes, category: plan.category, tags: plan.tags, caption: plan.caption });
    if (!result.duplicate) {
      await service.index(result.design).catch(() => undefined);
      seeded += 1;
    }
  }
  return { seeded };
}
