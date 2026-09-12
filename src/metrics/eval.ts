import fs from "node:fs/promises";
import path from "node:path";
import type { RecallResult } from "engram-memory";
import type { HenryConfig } from "../config.ts";
import type { KnowledgeBase } from "../knowledge/store.ts";

/** precision@5 is the harness's whole reason to exist — fix k here rather than making it per-query. */
const EVAL_K = 5;

/** One seed query, shaped for `data/eval/queries.json` (docs/dashboard-design-v2.md §C). */
export interface EvalQuery {
  query: string;
  store: "knowledge";
  /** Case-insensitive substrings of the expected hit's module label — any one matching counts as a hit. */
  expectModuleContains: string[];
}

export interface EvalQueryResult {
  query: string;
  expectModuleContains: string[];
  pass: boolean;
  /** 1-based rank of the first matching hit within the top EVAL_K, or null if none matched. */
  rank: number | null;
  topModule: string | null;
  error?: string;
}

export interface EvalReport {
  ts: string;
  queryCount: number;
  precisionAt5: number | null;
  mrr: number | null;
  results: EvalQueryResult[];
}

type ScorableHit = Pick<RecallResult, "metadata" | "source">;

/** The label an eval hit is graded on: metadata.module, falling back to moduleId then the raw source path. */
function moduleOf(hit: ScorableHit): string {
  const meta = (hit.metadata || {}) as Record<string, unknown>;
  return String(meta.module ?? meta.moduleId ?? hit.source ?? "");
}

function isMatch(moduleLabel: string, expectModuleContains: string[]): boolean {
  const lower = moduleLabel.toLowerCase();
  return expectModuleContains.some((needle) => lower.includes(needle.toLowerCase()));
}

/**
 * Pure scorer: grades already-fetched top-K hits against each query's expectation. Kept separate
 * from `runKnowledgeEval` below so tests can exercise precision@5/MRR math on fixture data
 * without a live engine. `errors[i]` (if set) marks query i as a hard fail (engine threw) —
 * still counted in the denominator, since it plainly didn't surface the expected module.
 */
export function scoreEvalQueries(queries: EvalQuery[], hitsByQuery: ScorableHit[][], errors: (string | undefined)[] = []): EvalReport {
  const results: EvalQueryResult[] = queries.map((q, index) => {
    const error = errors[index];
    if (error) return { query: q.query, expectModuleContains: q.expectModuleContains, pass: false, rank: null, topModule: null, error };
    const hits = (hitsByQuery[index] || []).slice(0, EVAL_K);
    let rank: number | null = null;
    for (let i = 0; i < hits.length; i += 1) {
      if (isMatch(moduleOf(hits[i]), q.expectModuleContains)) { rank = i + 1; break; }
    }
    return { query: q.query, expectModuleContains: q.expectModuleContains, pass: rank !== null, rank, topModule: hits[0] ? moduleOf(hits[0]) : null };
  });
  const graded = results.length;
  const passCount = results.filter((r) => r.pass).length;
  const reciprocalSum = results.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0);
  return {
    ts: new Date().toISOString(),
    queryCount: graded,
    precisionAt5: graded ? passCount / graded : null,
    mrr: graded ? reciprocalSum / graded : null,
    results,
  };
}

/**
 * Runs the seed eval set (`config.evalPath`) against the real `KnowledgeBase.recall` pipeline
 * (domain boost, per-module cap, card-priority — exactly what production callers get), but
 * read-only: `markUsed`/`reinforce` both false, so grading a query never distorts salience (the
 * same rule the dashboard's Recall Lab follows). `KnowledgeBase.recall` already carries the
 * recall-metrics instrumentation hook, so every eval query lands in the same event log as a
 * normal recall attempt — no separate instrumentation needed here. Scores with
 * `scoreEvalQueries`, writes `last-run.json` next to the seed file, and returns the report.
 */
export async function runKnowledgeEval(config: HenryConfig, kb: KnowledgeBase): Promise<EvalReport> {
  const raw = await fs.readFile(config.evalPath, "utf8");
  const queries = JSON.parse(raw) as EvalQuery[];
  const hitsByQuery: ScorableHit[][] = [];
  const errors: (string | undefined)[] = [];

  for (const q of queries) {
    try {
      const hits = await kb.recall(q.query, { k: EVAL_K, markUsed: false, reinforce: false });
      hitsByQuery.push(hits);
      errors.push(undefined);
    } catch (error) {
      hitsByQuery.push([]);
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const report = scoreEvalQueries(queries, hitsByQuery, errors);
  const lastRunPath = path.join(path.dirname(config.evalPath), "last-run.json");
  await fs.mkdir(path.dirname(lastRunPath), { recursive: true, mode: 0o700 }).catch(() => undefined);
  await fs.writeFile(lastRunPath, JSON.stringify(report, null, 2), "utf8");
  return report;
}

/** Human-readable report table for the CLI: a summary line + one PASS/FAIL row per query. */
export function formatEvalReport(report: EvalReport): string {
  const pct = (value: number | null): string => (value === null ? "n/a" : `${(value * 100).toFixed(0)}%`);
  const lines = [
    `Knowledge eval — ${report.ts}`,
    `precision@5: ${pct(report.precisionAt5)}   MRR: ${report.mrr === null ? "n/a" : report.mrr.toFixed(2)}   (${report.queryCount} queries)`,
    "",
  ];
  for (const r of report.results) {
    const rank = r.rank === null ? "-" : `#${r.rank}`;
    const detail = r.error ? `ERROR: ${r.error}` : `expected[${r.expectModuleContains.join(" | ")}] got "${r.topModule ?? ""}"`;
    lines.push(`${r.pass ? "PASS" : "FAIL"}  ${rank.padEnd(3)}  ${r.query}\n        ${detail}`);
  }
  return lines.join("\n");
}
