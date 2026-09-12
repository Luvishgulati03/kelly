import { mkdirSync } from "node:fs";
import path from "node:path";
import { Engram } from "engram-memory";
import type { RecallResult } from "engram-memory";
import type { HenryConfig } from "../config.ts";
import { LocalEmbeddingProvider } from "../embeddings.ts";
import { hashQuery, recordRecallEvent } from "../metrics/recall-metrics.ts";

export const KNOWLEDGE_DOMAINS = [
  "gtm", "growth-strategy", "product-management", "software-development",
  "community", "sales", "careers", "general",
 "project-management"] as const;
export type KnowledgeDomain = (typeof KNOWLEDGE_DOMAINS)[number];

export interface KnowledgeEntry {
  content: string;
  source: string;
  metadata: Record<string, unknown>;
  importance?: number;
}

/**
 * The curated domain-knowledge index (the organization's learning platform + future sources).
 * Separate from personal memory by design: versioned, source-attributed,
 * no decay/supersede lifecycle, injected on demand rather than every turn.
 * Proprietary content — knowledge/ and data/knowledge.db never leave this machine.
 */
export class KnowledgeBase {
  readonly engine: Engram;

  constructor(private readonly config: HenryConfig) {
    mkdirSync(path.dirname(config.knowledgeDbPath), { recursive: true, mode: 0o700 });
    this.engine = new Engram({ dbPath: config.knowledgeDbPath, defaultK: 8, embedding: new LocalEmbeddingProvider() });
  }

  async add(entry: KnowledgeEntry): Promise<string> {
    return this.engine.add({
      content: entry.content, source: entry.source, tier: "semantic",
      importance: entry.importance ?? 6, metadata: entry.metadata,
    });
  }

  /**
   * Cards outrank raw chunks; a domain filter narrows recall when the task declares one.
   * Production-RAG-proven rules: score threshold beats pure top-K (kills false positives),
   * and capping results per module keeps the context diverse.
   */
  async recall(query: string, options: { k?: number; domain?: string; layer?: "card" | "raw"; minScore?: number; markUsed?: boolean; reinforce?: boolean; excludeDomains?: string[] } = {}): Promise<RecallResult[]> {
    const k = options.k ?? 8;
    // Engram's fused hybrid scores live in a small range; 0.02 is the empirical noise floor.
    const minScore = options.minScore ?? 0.02;
    const startedAt = Date.now();
    const base = { ts: new Date().toISOString(), store: "knowledge" as const, queryHash: hashQuery(query), k };
    // excludeDomains is the ONE hard domain filter in this class (`domain` above is a soft
    // boost by design). Blocked lanes must be removed post-hoc, so over-fetch 2x the usual
    // window first — otherwise a page full of excluded hits would starve the k survivors.
    const excluded = new Set((options.excludeDomains ?? []).filter((entry) => typeof entry === "string" && entry.length > 0));
    const fetchK = excluded.size ? k * 8 : k * 4;
    // Both default true (unchanged behavior for every existing caller). Read-only callers —
    // the eval harness, a future recall-lab preview — pass both false so grading/browsing never
    // distorts salience.
    const raw = await this.engine.recall(query, { k: fetchK, associative: true, markUsed: options.markUsed ?? true, reinforce: options.reinforce ?? true })
      .catch((error) => {
        recordRecallEvent(this.config, { ...base, results: 0, topScore: null, latencyMs: Date.now() - startedAt, engineError: error instanceof Error ? error.message : String(error) });
        throw error;
      });
    // Filtered BEFORE ranking so excluded rows never consume the per-module cap either.
    const results = excluded.size
      ? raw.filter((result) => !excluded.has(String(((result.metadata || {}) as Record<string, unknown>).domain ?? "")))
      : raw;
    // Production-RAG lesson: a declared domain BOOSTS ranking but never hard-filters —
    // hard domain filters create blind spots (community content answering a GTM query).
    const boosted = options.domain
      ? results.map((result) => {
          const meta = (result.metadata || {}) as Record<string, unknown>;
          return meta.domain === options.domain ? { ...result, score: result.score * 1.5 } : result;
        }).sort((a, b) => b.score - a.score)
      : results;
    const perModule = new Map<string, number>();
    const filtered = boosted.filter((result) => {
      const meta = (result.metadata || {}) as Record<string, unknown>;
      if (result.score < minScore) return false;
      if (options.layer && meta.layer !== options.layer) return false;
      const moduleKey = String(meta.moduleId || meta.module || result.source);
      const seen = perModule.get(moduleKey) || 0;
      if (seen >= 2) return false;
      perModule.set(moduleKey, seen + 1);
      return true;
    });
    // Score-interleaved with a cards-preferred tiebreak (Henry's own field report:
    // absolute cards-first buried every fresh import under the module-card corpus).
    // EDGE=2.0 chosen by eval sweep 2026-08-07: recovers cards-first precision@5 (33%) while letting high-scoring imports surface (1.15/1.5 scored 25%).
    const CARD_EDGE = 2.0;
    const ranked = filtered
      .map((r) => ({ r, eff: r.score * (((r.metadata as Record<string, unknown> | null)?.layer === "card") ? CARD_EDGE : 1) }))
      .sort((a, b) => b.eff - a.eff)
      .map((x) => x.r);
    const final = ranked.slice(0, k);
    recordRecallEvent(this.config, { ...base, results: final.length, topScore: final[0]?.score ?? null, latencyMs: Date.now() - startedAt });
    return final;
  }

  /**
   * Labeled context block so the model treats this as tried-and-tested practice, not
   * general knowledge. The header carries an explicit coverage band so the agent can
   * route: strong -> trust the corpus, partial -> corpus core + web fill. An explicit
   * NO-coverage marker (never "") keeps "consulted and empty" distinguishable from
   * "never consulted" — that distinction triggers the web-research lane.
   */
  static readonly NO_COVERAGE_MARKER = "--- Curated knowledge: NO relevant coverage for this query (corpus was consulted) ---";

  async context(query: string, options: { k?: number; domain?: string; budgetChars?: number; excludeDomains?: string[] } = {}): Promise<string> {
    const results = await this.recall(query, options);
    if (!results.length) return KnowledgeBase.NO_COVERAGE_MARKER;
    const budget = options.budgetChars ?? 8000;
    // Bands calibrated on the fused-score scale (floor 0.02; confident hits ~0.04+).
    const coverage = results.length >= 3 && results[0].score >= 0.04 ? "strong" : "partial";
    const lines: string[] = [`--- Curated knowledge (tried & tested playbooks) · coverage: ${coverage} ---`];
    let used = 0;
    for (const result of results) {
      const meta = (result.metadata || {}) as Record<string, unknown>;
      const header = `[${meta.domain || "general"} · ${meta.module || result.source}]`;
      const chunk = `${header}\n${result.content.trim()}`;
      if (used + chunk.length > budget) break;
      lines.push(chunk);
      used += chunk.length;
    }
    return lines.join("\n\n");
  }

  stats(): Record<string, unknown> { return this.engine.stats() as unknown as Record<string, unknown>; }
  close(): void { this.engine.close(); }
}
