import fs from "node:fs/promises";
import type { DesignService } from "./rag.ts";
import { imageFilesInFolder } from "./store.ts";

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}
function csv(value: string | undefined): string[] | undefined {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : undefined;
}
function designUrl(id: string): string { return `/api/designs/${id}/image`; }
function toJson(design: ReturnType<DesignService["store"]["get"]>) {
  if (!design) return undefined;
  return {
    id: design.id, category: design.category, tags: design.tags, caption: design.caption,
    colours: design.colours, fabric: design.fabric, occasion: design.occasion, priceBand: design.priceBand,
    url: designUrl(design.id),
  };
}

async function addOne(service: DesignService, filePath: string, options: { category: string; tags?: string[]; caption?: string; colours?: string[]; fabric?: string; occasion?: string; priceBand?: string }): Promise<unknown> {
  const bytes = await fs.readFile(filePath);
  const result = service.store.add({ bytes, ...options });
  if (!result.duplicate) await service.index(result.design).catch(() => undefined);
  return { ...result, path: filePath };
}

export async function runDesignsCommand(service: DesignService, args: string[]): Promise<unknown> {
  const sub = args[0];
  if (sub === "add") {
    const target = args[1];
    if (!target) throw new Error("Usage: kelly designs add <file|folder> --category <category> [--tags a,b] [--caption \"...\"] [--colours a,b] [--fabric x] [--occasion x] [--price-band lo-hi]");
    const category = option(args, "--category");
    if (!category) throw new Error("--category is required");
    const options = {
      category, tags: csv(option(args, "--tags")), caption: option(args, "--caption"),
      colours: csv(option(args, "--colours")), fabric: option(args, "--fabric"),
      occasion: option(args, "--occasion"), priceBand: option(args, "--price-band"),
    };
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      const files = await imageFilesInFolder(target);
      const results = [];
      for (const file of files) results.push(await addOne(service, file, options));
      return { added: results.length, results };
    }
    return addOne(service, target, options);
  }
  if (sub === "list") {
    const asJson = args.includes("--json");
    const results = service.store.list({
      category: option(args, "--category"), tags: csv(option(args, "--tags")),
      latest: args.includes("--latest"), trending: args.includes("--trending"),
    });
    return asJson ? { designs: results.map(toJson) } : results;
  }
  if (sub === "search") {
    const query = args[1] && !args[1].startsWith("--") ? args[1] : "";
    const results = await service.find(query, {
      category: option(args, "--category"),
      tags: csv(option(args, "--tags")),
      latest: args.includes("--latest"),
      trending: args.includes("--trending"),
      limit: Number(option(args, "--limit")) || 8,
    });
    return { designs: results.map(toJson) };
  }
  if (sub === "hide") {
    const id = args[1];
    if (!id) throw new Error("Usage: kelly designs hide <id>");
    return service.store.hide(id);
  }
  if (sub === "tag") {
    const id = args[1];
    if (!id) throw new Error("Usage: kelly designs tag <id> --add x --remove y");
    const existing = service.store.get(id);
    if (!existing) throw new Error(`Design not found: ${id}`);
    const add = csv(option(args, "--add")) ?? [];
    const remove = new Set(csv(option(args, "--remove")) ?? []);
    const tags = [...new Set([...existing.tags.filter((tag) => !remove.has(tag)), ...add])];
    return service.store.update(id, { tags });
  }
  if (sub === "stats") return service.store.stats();
  throw new Error("Usage: kelly designs add|list|search|hide|tag|stats");
}
