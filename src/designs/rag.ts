import path from "node:path";
import type { HenryConfig } from "../config.ts";
import { KnowledgeBase } from "../knowledge/store.ts";
import { DesignStore, type DesignFilter, type DesignRecord } from "./store.ts";
import { tokenize, resolveTerm, type VocabularyPack } from "./vocabulary.ts";

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
  private readonly vocab: VocabularyPack;

  constructor(
    private readonly config: HenryConfig,
    categories: string[],
    tags: string[],
    aliases: Record<string, string[]> = {},
    rag?: DesignRagPort,
  ) {
    this.store = new DesignStore(config.dataDir, categories, tags);
    this.vocab = { galleryCategories: categories, galleryTags: tags, aliases };
    this.rag = rag;
  }

  private async semantic(): Promise<DesignRagPort> {
    if (!this.rag) this.rag = new DesignRag(this.config);
    return this.rag;
  }

  /**
   * A customer's words carry structure: "trending sarees" is the tag `trending` plus the
   * category `saree`, not a caption to match. So the query is read first for tags, category
   * words (singular or plural), and the latest/trending intents; only what is left is free
   * text. Free text narrows the structured result when it matches something, and is dropped
   * (with the semantic lane as a last try) when it does not, so "red sarees" with no red
   * saree still shows sarees rather than nothing.
   */
  async find(query: string, filter: DesignFilter = {}): Promise<DesignRecord[]> {
    const parsed = this.parseQuery(query, filter);
    const base = this.store.list({ ...filter, category: parsed.category, tags: parsed.tags, latest: parsed.latest, trending: parsed.trending, text: undefined });
    let results = base;
    if (parsed.words.length) {
      const narrowed = base.filter((design) => {
        const hay = [design.caption, design.colours.join(" "), design.fabric, design.occasion].join(" ").toLowerCase();
        return parsed.words.some((word) => hay.includes(word));
      });
      if (narrowed.length) results = narrowed;
    }
    if (results.length >= 3 || !parsed.words.length) return results;
    const ids = await (await this.semantic()).search(parsed.words.join(" "), 8);
    const seen = new Set(results.map((design) => design.id));
    const extra = ids
      .map((id) => this.store.get(id))
      .filter((design): design is DesignRecord => Boolean(design) && design!.status === "active" && !seen.has(design!.id))
      .filter((design) => !parsed.category || design.category === parsed.category);
    return [...results, ...extra];
  }

  private parseQuery(query: string, filter: DesignFilter): { category?: string; tags: string[]; latest: boolean; trending: boolean; words: string[] } {
    const tags = new Set(filter.tags ?? []);
    let category = filter.category;
    let latest = Boolean(filter.latest);
    let trending = Boolean(filter.trending);
    const words: string[] = [];
    const stop = new Set(["show", "me", "some", "any", "the", "of", "for", "in", "please", "designs", "design", "photos", "pictures", "images", "want", "see", "with", "and"]);
    for (const token of tokenize(query)) {
      const resolved = resolveTerm(token, this.vocab);
      if (resolved) {
        if (resolved.kind === "category") { category ??= resolved.value; continue; }
        if (resolved.kind === "tag") { tags.add(resolved.value); continue; }
        if (resolved.kind === "latest") { latest = true; continue; }
        trending = true;
        continue;
      }
      if (!stop.has(token) && token.length > 2 && /^[a-z-]+$/.test(token)) words.push(token);
    }
    return { category, tags: [...tags], latest, trending, words };
  }

  async index(design: DesignRecord): Promise<void> {
    await (await this.semantic()).index(design);
  }

  close(): void { this.store.close(); this.rag?.close(); }
}
