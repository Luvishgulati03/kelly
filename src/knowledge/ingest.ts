import fs from "node:fs/promises";
import path from "node:path";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { ProviderRunner } from "../providers/runner.ts";
import { KnowledgeBase, type KnowledgeDomain, type KnowledgeEntry } from "./store.ts";

/** Maps free-form filter strings / module names onto Henry's domain taxonomy. */
export function deriveDomain(hints: string[]): KnowledgeDomain {
  const text = hints.join(" ").toLowerCase();
  // project-management first (audit 2026-08-09 B-M2c): without this branch, ingested
  // PM material could never carry the tag the PM-mode retrieval boost looks for.
  if (/project.?manage|pmbok|\bpmp\b|earned value|risk register|critical path|\bwbs\b/.test(text)) return "project-management";
  if (/\bgtm\b|go[ -]?to[ -]?market|\blaunch\b|\bdistribution\b/.test(text)) return "gtm";
  if (/growth|acquisition|retention|funnel|marketing/.test(text)) return "growth-strategy";
  if (/product|pm\b|roadmap|prd|discovery/.test(text)) return "product-management";
  if (/engineer|develop|tech|coding|software|api\b/.test(text)) return "software-development";
  if (/community|member/.test(text)) return "community";
  if (/sales|pipeline|outbound|deal/.test(text)) return "sales";
  if (/career|talent|interview|resume|job/.test(text)) return "careers";
  return "general";
}

/** Exported for reuse by the generic importer (importer.ts) — same chunking, any source. */
export function chunkText(text: string, size = 1400, overlap = 200): string[] {
  const clean = text.replace(/\s+\n/g, "\n").trim();
  if (clean.length <= size) return clean ? [clean] : [];
  const chunks: string[] = [];
  for (let start = 0; start < clean.length; start += size - overlap) {
    const slice = clean.slice(start, start + size);
    const cut = start + size < clean.length ? Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("\n")) : slice.length;
    chunks.push(slice.slice(0, cut > size / 2 ? cut + 1 : slice.length).trim());
  }
  return chunks.filter(Boolean);
}

function parseFrontmatterFile(raw: string): { fields: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n+/);
  if (!match) return { fields: {}, body: raw };
  const fields: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    try { fields[line.slice(0, idx).trim()] = JSON.parse(line.slice(idx + 1).trim()); }
    catch { fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim(); }
  }
  return { fields, body: raw.slice(match[0].length) };
}

interface StrategyCard { claim: string; whenToUse: string; steps: string[]; evidence: string }

interface ModuleDoc { _id: string | { $oid: string }; name: string }

export interface IngestReport { entries: number; skipped: number; byDomain: Record<string, number> }
export interface DistillReport { modules: number; cards: number; remaining: number; failed: number }

/**
 * Load modules.json into a Map<moduleId, moduleName> for resolution.
 * Handles _id as both string and {$oid} format.
 * Returns empty map if file doesn't exist.
 */
async function loadModulesMap(rawDir: string): Promise<Map<string, string>> {
  const modulesPath = path.join(rawDir, "modules.json");
  try {
    const content = await fs.readFile(modulesPath, "utf8");
    const modules = JSON.parse(content) as ModuleDoc[];
    const map = new Map<string, string>();
    for (const mod of modules) {
      const id = typeof mod._id === "string" ? mod._id : mod._id.$oid;
      map.set(id, mod.name);
    }
    return map;
  } catch {
    // Gracefully degrade if modules.json is missing or invalid
    return new Map();
  }
}

/**
 * Two-layer ingestion: `ingestRaw` indexes the exported corpus with local
 * embeddings (zero LLM calls); `ingestCards` distills modules into strategy
 * cards via the subscription CLI, budgeted per run so quota is never flooded.
 */
export class KnowledgeIngestor {
  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    private readonly kb: KnowledgeBase,
    private readonly runner: ProviderRunner,
  ) {}

  private get rawDir(): string { return path.join(this.config.knowledgeDir, "raw"); }
  private get cardsDir(): string { return path.join(this.config.knowledgeDir, "cards"); }

  private async collectRawEntries(): Promise<KnowledgeEntry[]> {
    const entries: KnowledgeEntry[] = [];
    const modulesMap = await loadModulesMap(this.rawDir);
    const chunksRaw = await fs.readFile(path.join(this.rawDir, "chunks.jsonl"), "utf8").catch(() => "");
    for (const line of chunksRaw.split("\n").filter(Boolean)) {
      const chunk = JSON.parse(line) as Record<string, unknown>;
      const text = String(chunk.text || chunk.content || "");
      if (text.length < 80) continue;
      const moduleId = String(chunk.module_id || "");
      const catalogName = moduleId ? modulesMap.get(moduleId) : undefined;
      const module = catalogName || String(chunk.module_name || moduleId || "unknown-module");
      const concepts = Array.isArray(chunk.teaches_concepts) ? chunk.teaches_concepts.map(String) : [];
      const title = String(chunk.chapter_title || chunk.title || "");
      entries.push({
        content: title ? `${title}\n${text}` : text,
        source: `org-learn/chunks/${String(chunk._id)}`,
        metadata: { layer: "raw", domain: deriveDomain([module, title, ...concepts]), module, concepts, difficulty: chunk.difficulty, contentRole: chunk.content_role, moduleId },
      });
    }
    for (const sub of ["transcripts", "texts"]) {
      const dir = path.join(this.rawDir, sub);
      for (const file of await fs.readdir(dir).catch(() => [] as string[])) {
        if (!file.endsWith(".md")) continue;
        const { fields, body } = parseFrontmatterFile(await fs.readFile(path.join(dir, file), "utf8"));
        const module = String(fields.module || file);
        const filters = Array.isArray(fields.filters) ? fields.filters.map(String) : [];
        const domain = deriveDomain([module, ...filters]);
        for (const [index, piece] of chunkText(body).entries()) {
          entries.push({
            content: `${module} (part ${index + 1})\n${piece}`,
            source: `org-learn/${sub}/${file}#${index + 1}`,
            metadata: { layer: "raw", domain, module, moduleId: fields.moduleId, filters },
          });
        }
      }
    }
    return entries;
  }

  async ingestRaw(options: { limit?: number } = {}): Promise<IngestReport> {
    const all = await this.collectRawEntries();
    const entries = options.limit ? all.slice(0, options.limit) : all;
    const report: IngestReport = { entries: 0, skipped: 0, byDomain: {} };
    for (const entry of entries) {
      try {
        await this.kb.add(entry);
        report.entries += 1;
        const domain = String(entry.metadata.domain);
        report.byDomain[domain] = (report.byDomain[domain] || 0) + 1;
      } catch { report.skipped += 1; }
    }
    await this.activity.record("memory.saved", `Knowledge base indexed ${report.entries} raw entries`, { ...report });
    return report;
  }

  /**
   * Distills up to `limit` modules into strategy cards per run (checkpointed; resumes where it left off).
   * Provider calls for distinct modules run concurrently via a simple promise-pool; the checkpoint
   * (`done` Set + file write) is serialized through an in-process mutex so concurrent workers never
   * interleave writes, and a per-module try/catch keeps one failure from aborting the rest of the batch.
   */
  async ingestCards(options: { limit?: number; concurrency?: number } = {}): Promise<DistillReport> {
    const limit = options.limit ?? 3;
    // M1 8GB resource policy (MASTER_PLAN §7): never run more than 3 concurrent provider workers,
    // even if a caller asks for more.
    const concurrency = Math.min(options.concurrency ?? 3, 3);
    await fs.mkdir(this.cardsDir, { recursive: true, mode: 0o700 });
    const checkpointPath = path.join(this.cardsDir, ".distilled.json");
    const done = new Set<string>(JSON.parse(await fs.readFile(checkpointPath, "utf8").catch(() => "[]")) as string[]);
    const byModule = new Map<string, KnowledgeEntry[]>();
    for (const entry of await this.collectRawEntries()) {
      const key = `${entry.metadata.moduleId || entry.metadata.module}`;
      if (!byModule.has(key)) byModule.set(key, []);
      byModule.get(key)!.push(entry);
    }
    const pending = [...byModule.entries()].filter(([key]) => !done.has(key));
    const batch = pending.slice(0, limit);
    const report: DistillReport = { modules: 0, cards: 0, remaining: Math.max(0, pending.length - limit), failed: 0 };

    // Serializes checkpoint mutations across concurrent workers — same promise-chain mutex
    // pattern as ApprovalStore.mutate() (src/approval/store.ts).
    let checkpointChain = Promise.resolve();
    const withCheckpointLock = <T>(operation: () => Promise<T>): Promise<T> => {
      const previous = checkpointChain;
      let release!: () => void;
      checkpointChain = new Promise<void>((resolve) => { release = resolve; });
      return previous.then(operation, operation).finally(release);
    };

    const processModule = async ([key, moduleEntries]: [string, KnowledgeEntry[]]): Promise<void> => {
      const module = String(moduleEntries[0].metadata.module);
      const domain = String(moduleEntries[0].metadata.domain);
      const corpus = moduleEntries.map((entry) => entry.content).join("\n\n").slice(0, 60_000);
      const prompt = [
        "Distill this learning-module transcript into 3-8 atomic strategy cards.",
        "Each card = one tried-and-tested tactic/principle actually taught in the content. Never invent; quote-derived evidence only.",
        'Return ONLY a JSON array: [{"claim":string,"whenToUse":string,"steps":string[],"evidence":string}]',
        `\n--- module: ${module} ---\n${corpus}`,
      ].join("\n");
      try {
        // Provider call: the concurrent part of the pipeline. Not under any lock.
        const result = await this.runner.run(prompt, { role: "knowledge-distill", readOnly: true });
        if (result.exitCode !== 0) { report.failed += 1; return; }
        let cards: StrategyCard[] = [];
        try {
          const fenced = result.response.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || result.response;
          cards = (JSON.parse(fenced.slice(fenced.indexOf("["), fenced.lastIndexOf("]") + 1)) as StrategyCard[]).filter((card) => card.claim);
        } catch { report.failed += 1; return; }
        const cardFile = path.join(this.cardsDir, `${key.replace(/[^a-zA-Z0-9-]/g, "-")}.md`);
        const rendered = cards.map((card) => `## ${card.claim}\n\n**When to use:** ${card.whenToUse}\n\n${card.steps.map((step) => `- ${step}`).join("\n")}\n\n**Evidence:** ${card.evidence}`).join("\n\n");
        // File write is scoped to this module's own card file — safe to interleave across workers.
        await fs.writeFile(cardFile, `# ${module} — strategy cards\n\n${rendered}\n`, "utf8");
        for (const card of cards) {
          // Engram/SQLite from one process tolerates interleaved awaits across workers.
          await this.kb.add({
            content: `${card.claim}\nWhen to use: ${card.whenToUse}\nSteps: ${card.steps.join("; ")}\nEvidence: ${card.evidence}`,
            source: `org-learn/cards/${path.basename(cardFile)}`,
            importance: 8,
            metadata: { layer: "card", domain, module, moduleId: key },
          });
          report.cards += 1;
        }
        // Checkpoint mutation: guarded so two workers never race on `done` or the file write.
        await withCheckpointLock(async () => {
          done.add(key);
          report.modules += 1;
          await fs.writeFile(checkpointPath, JSON.stringify([...done], null, 1), "utf8");
        });
      } catch {
        // A single module's failure never aborts the rest of the batch.
        report.failed += 1;
      }
    };

    // Simple promise-pool: up to `concurrency` workers pull the next pending module until the batch drains.
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < batch.length) {
        const index = cursor;
        cursor += 1;
        await processModule(batch[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, () => worker()));

    await this.activity.record("memory.saved", `Distilled ${report.cards} strategy cards from ${report.modules} modules`, { ...report });
    return report;
  }
}
