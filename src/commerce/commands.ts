import fs from "node:fs/promises";
import type { CommerceService } from "./service.ts";
import type { QuoteRequest, QuoteRequestLine } from "./types.ts";
import type { WorkbookEdit } from "./workbooks.ts";

function option(args: string[], name: string): string | undefined { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; }
async function jsonFile<T>(filePath: string | undefined, label: string): Promise<T> { if (!filePath) throw new Error(`${label} JSON file is required`); return JSON.parse(await fs.readFile(filePath, "utf8")) as T; }

const LINES_USAGE = 'Usage: --lines "<sku or free text> x<qty>, ..." (also accepts "<qty> x <sku>" or "<qty>x<sku>"; quantities may be decimal)';

/**
 * Parses the inline `--lines` grammar into QuoteRequestLine entries.
 * Grammar (comma-separated items): `<sku-or-text> x<qty>` | `<qty> x <sku-or-text>` | `<qty>x<sku-or-text>`.
 * Quantities may be decimal. An item that does not resolve to a known-looking SKU token becomes
 * a `query` line exactly as `--from` does (resolution against the catalogue happens later).
 */
export function parseLinesOption(raw: string): QuoteRequestLine[] {
  const items = raw.split(",").map((item) => item.trim()).filter(Boolean);
  if (!items.length) throw new Error(LINES_USAGE);
  const leadingQty = /^(\d+(?:\.\d+)?)\s*x\s*(.+)$/i;
  const trailingQty = /^(.+?)\s*x\s*(\d+(?:\.\d+)?)$/i;
  return items.map((item) => {
    let quantity: number | undefined; let text: string | undefined;
    const leading = item.match(leadingQty);
    const trailing = item.match(trailingQty);
    if (leading) { quantity = Number(leading[1]); text = leading[2].trim(); }
    else if (trailing) { text = trailing[1].trim(); quantity = Number(trailing[2]); }
    if (quantity === undefined || !text) throw new Error(`${LINES_USAGE} (could not parse "${item}")`);
    // A single token (no internal whitespace) is treated as a SKU; free text with spaces is a
    // catalogue-search query. Either way an unmatched entry surfaces as `unresolved`, exactly
    // as an unmatched line from `--from` JSON does.
    const looksLikeSku = /^\S+$/.test(text);
    return looksLikeSku ? { sku: text, quantity } : { query: text, quantity };
  });
}

export async function runCommerceCommand(service: CommerceService, command: string, args: string[]): Promise<unknown> {
  if (command === "catalogue") {
    const sub = args[0];
    if (sub === "import") { if (!args[1]) throw new Error("Usage: kelly catalogue import <file> [--sheet name]"); return service.importCatalogue(args[1], { sheet: option(args, "--sheet") }); }
    if (sub === "publish") { if (!args[1]) throw new Error("Usage: kelly catalogue publish <document-id>"); return await service.publish(args[1]); }
    if (sub === "review") return service.documents();
    if (sub === "search") return await service.search(args[1] || "", option(args, "--brand"), args.includes("--pending"));
    if (sub === "template") return { outputPath: await service.catalogueTemplate(option(args, "--out")) };
    throw new Error("Usage: kelly catalogue import|publish|review|search|template");
  }
  if (command === "quote") {
    const sub = args[0];
    if (sub === "create") {
      const linesOption = option(args, "--lines");
      const request: QuoteRequest = linesOption
        ? {
            lines: parseLinesOption(linesOption),
            brand: option(args, "--brand"),
            customerName: option(args, "--customer"),
            validDays: option(args, "--valid-days") ? Number(option(args, "--valid-days")) : undefined,
          }
        : await jsonFile<QuoteRequest>(option(args, "--from"), "Quote request");
      return service.createQuote(request);
    }
    if (sub === "show") { if (!args[1]) throw new Error("Usage: kelly quote show <id>"); return service.quote(args[1]); }
    if (sub === "compare") {
      const linesOption = option(args, "--lines");
      const request: Omit<QuoteRequest, "brand"> = linesOption
        ? {
            lines: parseLinesOption(linesOption),
            customerName: option(args, "--customer"),
            validDays: option(args, "--valid-days") ? Number(option(args, "--valid-days")) : undefined,
          }
        : await jsonFile<Omit<QuoteRequest, "brand">>(option(args, "--from"), "Quote request");
      const brands = (option(args, "--brands") || "").split(",").map((item) => item.trim()).filter(Boolean);
      return service.compare(request, brands);
    }
    if (sub === "export") { if (!args[1]) throw new Error("Usage: kelly quote export <id> [--out file.xlsx]"); return { outputPath: await service.exportQuote(args[1], option(args, "--out")) }; }
    throw new Error("Usage: kelly quote create|show|compare|export");
  }
  if (command === "sheets") {
    const sub = args[0]; const file = args[1]; if (!file) throw new Error("A workbook path is required");
    if (sub === "inspect") return service.inspectWorkbook(file);
    if (sub === "read") return service.readWorkbook(file, option(args, "--sheet") || "Sheet1", option(args, "--range") || "A1:F20");
    if (sub === "search") return service.searchWorkbook(file, option(args, "--query") || "");
    if (sub === "edit") return service.editWorkbook(file, await jsonFile<WorkbookEdit[]>(option(args, "--edits"), "Edits"), option(args, "--out"), option(args, "--sha256"));
    throw new Error("Usage: kelly sheets inspect|read|search|edit");
  }
  throw new Error(`Unknown commerce command: ${command}`);
}
