import fs from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Engram } from "engram-memory";
import type { GraphExport, RecallResult } from "engram-memory";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import { LocalEmbeddingProvider } from "../embeddings.ts";
import { hashQuery, planContextInjection, recordRecallEvent, recordRecallTrace } from "../metrics/recall-metrics.ts";

export class HenryMemory {
  readonly engine: Engram;
  private readonly embeddingMarkerPath: string;

  constructor(private readonly config: HenryConfig, private readonly activity: ActivityLog) {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    this.engine = new Engram({ dbPath: config.dbPath, defaultK: 8, embedding: new LocalEmbeddingProvider() });
    this.embeddingMarkerPath = path.join(config.dataDir, ".memory-embedding");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.config.memoryDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.config.capturedMemoryDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.config.dataDir, 0o700).catch(() => undefined);
    await this.engine.indexDirectory(this.config.memoryDir, { incremental: true });
    await fs.chmod(this.config.dbPath, 0o600).catch(() => undefined);
    await fs.chmod(`${this.config.dbPath}-wal`, 0o600).catch(() => undefined);
    await fs.chmod(`${this.config.dbPath}-shm`, 0o600).catch(() => undefined);
    await this.checkEmbeddingProviderMarker();
  }

  /**
   * Migration note: personal memory moved from Engram's default offline hashing
   * embedder to the local bge-small-en-v1.5 model. Vectors from the two
   * providers live in different spaces and are never comparable, but
   * engram-memory (as of node_modules/engram-memory/dist/engram.d.ts) doesn't
   * expose an aggregate "does the stored index match the active provider"
   * check — StoreStats/IndexResult report counts and the current run's model,
   * not what's already on disk. MemoryRecord.embeddingModel IS stored
   * per-row, so a future engram-memory release could add a real mismatch
   * check; until then this is a one-time manual step: after upgrading the
   * provider, run `henry memory index --fresh` once to wipe and re-embed
   * data/engram.db with the new model. We track the last-known-active
   * provider ourselves via a marker file (data/.memory-embedding) and warn
   * at startup if memories exist but were indexed under a different provider.
   */
  private async checkEmbeddingProviderMarker(): Promise<void> {
    const currentProvider = this.engine.embedding.name;
    const stats = this.engine.stats();
    const previous = await fs.readFile(this.embeddingMarkerPath, "utf8").catch(() => null);
    if (stats.count > 0 && previous !== null && previous.trim() !== currentProvider) {
      console.warn(
        `Henry memory: embedding provider changed (was "${previous.trim()}", now "${currentProvider}"). ` +
        `Existing vectors in ${this.config.dbPath} were embedded with the old provider and won't recall well ` +
        `against new queries. Run \`henry memory index --fresh\` once to re-embed.`,
      );
      // Keep the OLD marker on mismatch: overwriting it here would self-silence
      // this warning after a single startup while the stale vectors are still on
      // disk. The marker only advances when `memory index --fresh` actually
      // re-embeds everything (see index()).
      return;
    }
    await this.writeEmbeddingMarker(currentProvider);
  }

  private async writeEmbeddingMarker(provider: string): Promise<void> {
    await fs.writeFile(this.embeddingMarkerPath, provider, "utf8").catch(() => undefined);
    await fs.chmod(this.embeddingMarkerPath, 0o600).catch(() => undefined);
  }

  async recall(query: string, k = 8): Promise<RecallResult[]> {
    const startedAt = Date.now();
    const base = { ts: new Date().toISOString(), store: "personal" as const, queryHash: hashQuery(query), k };
    const results = await this.engine.recall(query, { k, associative: true, markUsed: true, reinforce: true })
      .catch((error) => {
        recordRecallEvent(this.config, { ...base, results: 0, topScore: null, latencyMs: Date.now() - startedAt, engineError: error instanceof Error ? error.message : String(error) });
        throw error;
      });
    recordRecallEvent(this.config, { ...base, results: results.length, topScore: results[0]?.score ?? null, latencyMs: Date.now() - startedAt });
    await this.activity.record("memory.recalled", `Recalled ${results.length} memories`, { query, results: results.map((r) => ({ id: r.id, why: r.why })) });
    return results;
  }

  /**
   * Budgeted context injection (latency §11.5 #3 / memory plan #5). The unbudgeted
   * version injected full memory bodies — a live turn measured promptChars 67k from
   * 8 memories. Rules: drop weak hits (score floor) instead of padding to k, cap each
   * memory's excerpt, cap the whole block. Distractor memories actively hurt recall
   * quality (LongMemEval), so lean is correct as well as fast.
   *
   * Both drops are invisible from the outside — the caller only ever sees the surviving
   * block — so this is also where the recall trace is written: planContextInjection builds
   * the block and classifies every returned memory used/below-threshold/truncated in the
   * same pass, and recordRecallTrace files that (ids/scores/why/source only, never content
   * or the raw query) fire-and-forget. A trace failure can never fail or slow this call.
   */
  async context(query: string, k = 8, options: { charBudget?: number; perMemoryChars?: number; minScore?: number } = {}): Promise<string> {
    const budget = {
      charBudget: options.charBudget ?? 4000,
      perMemoryChars: options.perMemoryChars ?? 700,
      minScore: options.minScore ?? 0.015,
    };
    const startedAt = Date.now();
    const results = await this.recall(query, k);
    const plan = planContextInjection(results, budget);
    recordRecallTrace(this.config, {
      ts: new Date().toISOString(), store: "personal", queryHash: hashQuery(query), k, ...budget,
      latencyMs: Date.now() - startedAt, returned: results.length, used: plan.usedCount,
      charsUsed: plan.charsUsed, memories: plan.memories,
    });
    return plan.text;
  }

  async remember(content: string, input: { source?: string; tier?: string; importance?: number; metadata?: Record<string, unknown> } = {}): Promise<string> {
    const now = new Date();
    const fileName = `${now.toISOString().replace(/[:.]/g, "-")}-${content.slice(0, 32).replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase() || "memory"}.md`;
    const source = input.source || path.join("captured", fileName);
    const absolute = path.join(this.config.memoryDir, source);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const frontmatter = [
      "---", `title: ${JSON.stringify(content.slice(0, 80))}`, `created: ${now.toISOString()}`,
      `tier: ${input.tier || "episodic"}`, `importance: ${input.importance ?? 6}`, "---", "",
    ].join("\n");
    let exists = false;
    try { await fs.access(absolute); exists = true; } catch { exists = false; }
    if (exists) {
      await fs.appendFile(absolute, `\n## ${now.toISOString()}\n\n${content.trim()}\n`, "utf8");
    } else {
      await fs.writeFile(absolute, `${frontmatter}${content.trim()}\n`, "utf8");
    }
    const id = await this.engine.add({
      content: content.trim(), source, tier: input.tier || "episodic",
      importance: input.importance ?? 6, metadata: input.metadata || null,
    });
    await this.activity.record("memory.saved", `Saved memory ${id}`, { id, source, content: content.slice(0, 240) });
    return id;
  }

  async index(fresh = false): Promise<unknown> {
    const result = await this.engine.indexDirectory(this.config.memoryDir, { incremental: !fresh, fresh });
    // A --fresh reindex wipes and re-embeds everything under the active provider —
    // the one moment a mismatched marker may legitimately advance.
    if (fresh) await this.writeEmbeddingMarker(this.engine.embedding.name);
    await this.activity.record("memory.saved", `Indexed memory directory (${result.memories} memories)`, { result });
    return result;
  }

  graph(): GraphExport { return this.engine.graphExport(); }

  async dream(): Promise<unknown> {
    const result = this.engine.dream({ consolidate: false });
    await this.activity.record("workflow.completed", "Engram dream completed", { result });
    return result;
  }

  close(): void { this.engine.close(); }
}
