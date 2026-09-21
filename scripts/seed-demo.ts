import path from "node:path";
import { fileURLToPath } from "node:url";
import { setActiveProfile } from "../src/profile.ts";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { CommerceService } from "../src/commerce/service.ts";

// Fixed isolated target. Never accept a production directory from command arguments.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
setActiveProfile("kelly");
const config = loadConfig(path.join(root, "data", "demo"));
const activity = new ActivityLog(config.activityPath);
await activity.init();
const commerce = new CommerceService(config, activity);
try {
  const imported = await commerce.importCatalogue(path.join(root, "examples/demo/catalogue.csv")) as { documentId: string; imported: number; duplicate: boolean };
  // User requested fictional mock data for testing. Publish only this bundled demo.
  const published = await commerce.publish(imported.documentId);
  const products = commerce.store.search("", undefined, false);
  const quote = commerce.createQuote({
    customerName: "DEMO customer (fictional)", brand: "DemoAster",
    lines: [{ sku: "DEMO-A-LED9", quantity: 10 }, { sku: "DEMO-A-FAN", quantity: 2 }],
  });
  if (!quote.complete || quote.totalPaise !== 590000) throw new Error("Demo quotation verification failed");
  console.log(JSON.stringify({ demoOnly: true, dataDir: config.dataDir, products: products.length, duplicateImport: imported.duplicate, published, verification: { totalRupees: quote.totalPaise / 100, expectedRupees: 5900, complete: quote.complete } }, null, 2));
} finally { commerce.close(); }
