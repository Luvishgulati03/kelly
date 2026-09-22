import fs from "node:fs/promises";
import path from "node:path";
import type { TradeId } from "../trade/index.ts";

interface TemplateSpec {
  fileName: string;
  sheetName: string;
  headers: string[];
  rows: Array<Array<string | number>>;
}

function boutiqueSpec(): TemplateSpec {
  return {
    fileName: "boutique-ratecard.xlsx",
    sheetName: "Rate card",
    headers: ["Code", "Garment", "Item", "Work type", "Unit", "Rate", "GST%"],
    rows: [
      ["SUIT-PLAIN", "Suit", "Salwar suit plain stitching", "Plain stitching", "per piece", 650, 5],
      ["SUIT-LINING", "Suit", "Salwar suit lining stitching", "Lining stitching", "per piece", 850, 5],
      ["SUIT-EMB-NECK", "Suit", "Hand embroidery on neck", "Embroidery", "per piece", 450, 5],
      ["BLOUSE-PLAIN", "Blouse", "Blouse plain stitching", "Plain stitching", "per piece", 400, 5],
      ["BLOUSE-PADDED", "Blouse", "Blouse padded stitching", "Padded stitching", "per piece", 550, 5],
      ["LEHENGA-CANCAN", "Lehenga", "Lehenga cancan lining", "Cancan lining", "per piece", 1200, 5],
      ["SAREE-FALL-PICO", "Saree", "Saree fall and pico", "Fall and pico", "per saree", 150, 5],
      ["KURTI-PLAIN", "Kurti", "Kurti plain stitching", "Plain stitching", "per piece", 350, 5],
      ["GOWN-PLAIN", "Gown", "Gown plain stitching", "Plain stitching", "per piece", 900, 5],
      ["DUPATTA-EDGE", "Dupatta", "Dupatta edge finishing", "Edge finishing", "per piece", 120, 5],
      ["URGENT-48H", "Surcharge", "Urgent delivery surcharge", "Urgent delivery surcharge", "per piece", 200, 5],
      ["FABRIC-GEORGETTE", "Fabric", "Georgette fabric", "Fabric supply", "per metre", 250, 5],
      ["FABRIC-COTTON", "Fabric", "Cotton fabric", "Fabric supply", "per metre", 150, 5],
      ["FITTING-ALTER", "Alteration", "Alteration", "Alteration", "per piece", 150, 5],
    ],
  };
}

function electricalSpec(): TemplateSpec {
  return {
    fileName: "electrical-catalogue.xlsx",
    sheetName: "Catalogue",
    headers: ["SKU", "Brand", "Name", "Category", "Unit", "Price", "GST%"],
    rows: [
      ["ELEC-MCB-16A", "Acme", "MCB 16A", "MCB", "piece", 120, 18],
      ["ELEC-MCB-32A", "Acme", "MCB 32A", "MCB", "piece", 150, 18],
      ["ELEC-SWITCH-6A", "Beta", "Modular switch 6A", "Switch", "piece", 45, 18],
      ["ELEC-WIRE-1.5", "Beta", "Copper wire 1.5 sq mm", "Wire", "metre", 12, 18],
      ["ELEC-BULB-9W", "Gamma", "LED bulb 9W", "Lighting", "piece", 90, 12],
      ["ELEC-FAN-CEILING", "Gamma", "Ceiling fan 1200mm", "Fan", "piece", 1450, 18],
    ],
  };
}

export function templateSpec(trade: TradeId): TemplateSpec {
  return trade === "boutique" ? boutiqueSpec() : electricalSpec();
}

/** Generates the trade pack's example rate-card/catalogue workbook and writes it to disk.
 * Returns the absolute output path. */
export async function generateCatalogueTemplate(trade: TradeId, outPath?: string, rootDir = process.cwd()): Promise<string> {
  const spec = templateSpec(trade);
  const selected = path.resolve(outPath || path.join(rootDir, "data", "templates", spec.fileName));
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(spec.sheetName);
  sheet.addRow(spec.headers);
  sheet.getRow(1).font = { bold: true };
  for (const row of spec.rows) sheet.addRow(row);
  await fs.mkdir(path.dirname(selected), { recursive: true });
  await workbook.xlsx.writeFile(selected);
  return selected;
}
