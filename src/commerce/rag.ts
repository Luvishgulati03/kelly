import path from "node:path";
import type { HenryConfig } from "../config.ts";
import { KnowledgeBase } from "../knowledge/store.ts";
import type { CatalogueProduct } from "./types.ts";

export class CatalogueRag {
  private readonly knowledge: KnowledgeBase;
  constructor(config: HenryConfig) {
    this.knowledge = new KnowledgeBase({ ...config, knowledgeDbPath: path.join(config.dataDir, "catalogue-rag.db") });
  }
  async index(products: CatalogueProduct[]): Promise<number> {
    for (const product of products) {
      await this.knowledge.add({
        source: `catalogue:${product.documentId}:${product.sourceLocation}`,
        content: [product.brand, product.sku, product.name, product.category, product.specification, product.unit].filter(Boolean).join(" | "),
        importance: 8,
        metadata: { layer: "catalogue", productId: product.id, documentId: product.documentId, brand: product.brand, sku: product.sku, sourceLocation: product.sourceLocation },
      });
    }
    return products.length;
  }
  async search(query: string, brand?: string, k = 8): Promise<unknown[]> {
    const results = await this.knowledge.recall(query, { k, minScore: 0.02, markUsed: false, reinforce: false });
    return results.filter((result) => !brand || String((result.metadata as Record<string, unknown>)?.brand || "").toLowerCase() === brand.toLowerCase())
      .map((result) => ({ score: result.score, content: result.content, source: result.source, metadata: result.metadata }));
  }
  stats(): Record<string, unknown> { return this.knowledge.stats(); }
  close(): void { this.knowledge.close(); }
}
