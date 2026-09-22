/**
 * Demo-mode catalogue seeding, shared by both trade packs. Only ever runs against the
 * isolated demo data directory `kelly start --demo` points at (see bin/start.mjs); it never
 * touches an owner's real KELLY_DATA_DIR. On first boot, when the demo catalogue has no
 * documents yet, it imports and publishes the trade pack's example rate card/catalogue
 * template so the demo has something real to quote against.
 */
import type { HenryConfig } from "../config.ts";
import { ActivityLog } from "../activity.ts";
import { CommerceService } from "./service.ts";
import { generateCatalogueTemplate } from "./template.ts";

export async function seedDemoCatalogueIfEmpty(config: HenryConfig): Promise<{ seeded: boolean }> {
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  const service = new CommerceService(config, activity);
  try {
    const existing = service.documents() as unknown[];
    if (existing.length > 0) return { seeded: false };
    const templatePath = await generateCatalogueTemplate(config.trade, undefined, config.rootDir);
    const imported = await service.importCatalogue(templatePath) as { documentId: string; duplicate: boolean };
    if (!imported.duplicate) await service.publish(imported.documentId);
    return { seeded: true };
  } finally {
    service.close();
  }
}
