import fs from "node:fs/promises";
import type { CommerceService } from "./service.ts";
import type { QuoteRequest } from "./types.ts";
import type { WorkbookEdit } from "./workbooks.ts";

function option(args: string[], name: string): string | undefined { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; }
async function jsonFile<T>(filePath: string | undefined, label: string): Promise<T> { if (!filePath) throw new Error(`${label} JSON file is required`); return JSON.parse(await fs.readFile(filePath, "utf8")) as T; }

export async function runCommerceCommand(service: CommerceService, command: string, args: string[]): Promise<unknown> {
  if (command === "catalogue") {
    const sub = args[0];
    if (sub === "import") { if (!args[1]) throw new Error("Usage: kelly catalogue import <file> [--sheet name]"); return service.importCatalogue(args[1], { sheet: option(args, "--sheet") }); }
    if (sub === "publish") { if (!args[1]) throw new Error("Usage: kelly catalogue publish <document-id>"); return await service.publish(args[1]); }
    if (sub === "review") return service.documents();
    if (sub === "search") return await service.search(args[1] || "", option(args, "--brand"), args.includes("--pending"));
    throw new Error("Usage: kelly catalogue import|publish|review|search");
  }
  if (command === "quote") {
    const sub = args[0];
    if (sub === "create") return service.createQuote(await jsonFile<QuoteRequest>(option(args, "--from"), "Quote request"));
    if (sub === "show") { if (!args[1]) throw new Error("Usage: kelly quote show <id>"); return service.quote(args[1]); }
    if (sub === "compare") { const request = await jsonFile<Omit<QuoteRequest, "brand">>(option(args, "--from"), "Quote request"); const brands = (option(args, "--brands") || "").split(",").map((item) => item.trim()).filter(Boolean); return service.compare(request, brands); }
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
