import path from "node:path";
import type { HenryConfig } from "../config.ts";
import { KnowledgeBase } from "../knowledge/store.ts";
import { DesignStore, type DesignFilter, type DesignRecord } from "./store.ts";

/**
 * Semantic fallback for the design gallery, mirroring commerce/rag.ts: caption, category,
 * tags, colours, fabric and occasion are indexed into a KnowledgeBase at data/designs-rag.db.
 * SQL (DesignStore.list) is always tried first; this only fills in when structured filters
 * come up short on a free-text ask.
 */
export class DesignRag {
  private readonly knowledge: KnowledgeBase;
  constructor(config: HenryConfig) {
    this.knowledge = new KnowledgeBase({ ...config, knowledgeDbPath: path.join(config.dataDir, "designs-rag.db") });
  }

  async index(design: DesignRecord): Promise<void> {
    await this.knowledge.add({
      source: `design:${design.id}`,
      content: [design.caption, design.category, design.tags.join(" "), design.colours.join(" "), design.fabric, design.occasion].filter(Boolean).join(" | "),
      importance: 6,
      metadata: { layer: "design", designId: design.id, category: design.category },
    });
  }

  async search(query: string, k = 8): Promise<string[]> {
    const results = await this.knowledge.recall(query, { k, minScore: 0.02, markUsed: false, reinforce: false });
    return results.map((result) => String((result.metadata as Record<string, unknown> | null)?.designId || "")).filter(Boolean);
  }

  stats(): Record<string, unknown> { return this.knowledge.stats(); }
  close(): void { this.knowledge.close(); }
}

export interface DesignRagPort {
  index(design: DesignRecord): Promise<void>;
  search(query: string, k?: number): Promise<string[]>;
  close(): void;
}

/**
 * Owns the DesignStore and the optional semantic lane. `find` is SQL first, semantic only
 * when SQL turns up fewer than 3 results AND the query carries free text worth embedding.
 */
export class DesignService {
  readonly store: DesignStore;
  private rag?: DesignRagPort;

  constructor(private readonly config: HenryConfig, categories: string[], tags: string[], rag?: DesignRagPort) {
    this.store = new DesignStore(config.dataDir, categories, tags);
    this.rag = rag;
  }

  private async semantic(): Promise<DesignRagPort> {
    if (!this.rag) this.rag = new DesignRag(this.config);
    return this.rag;
  }

  async find(query: string, filter: DesignFilter = {}): Promise<DesignRecord[]> {
    const sqlResults = this.store.list({ ...filter, text: query || filter.text });
    const cleanQuery = query.trim();
    if (sqlResults.length >= 3 || !cleanQuery) return sqlResults;
    const ids = await (await this.semantic()).search(cleanQuery, 8);
    const seen = new Set(sqlResults.map((design) => design.id));
    const extra = ids
      .map((id) => this.store.get(id))
      .filter((design): design is DesignRecord => Boolean(design) && design!.status === "active" && !seen.has(design!.id))
      .filter((design) => !filter.category || design.category === filter.category);
    return [...sqlResults, ...extra];
  }

  async index(design: DesignRecord): Promise<void> {
    await (await this.semantic()).index(design);
  }

  close(): void { this.store.close(); this.rag?.close(); }
}
