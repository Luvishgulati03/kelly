import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import type { HenryConfig } from "../src/config.ts";
import {
  hashQuery,
  planContextInjection,
  readRecallTraces,
  recordRecallEvent,
  recordRecallTrace,
  rotateRecallTracesIfNeeded,
  summarizeRecallMetrics,
  TRACE_FILE_MAX_BYTES,
  TRACE_RETAIN_LINES,
  type RecallEvent,
  type RecallTrace,
} from "../src/metrics/recall-metrics.ts";
import { scoreEvalQueries, type EvalQuery } from "../src/metrics/eval.ts";

async function tempConfig(): Promise<HenryConfig> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-recall-metrics-"));
  return loadConfig(rootDir);
}

async function writeEventsFile(config: HenryConfig, lines: string[]): Promise<void> {
  await fs.mkdir(config.metricsDir, { recursive: true });
  await fs.writeFile(path.join(config.metricsDir, "recall-events.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

function event(overrides: Partial<RecallEvent> = {}): RecallEvent {
  return { ts: new Date().toISOString(), store: "knowledge", queryHash: "abc123def456", k: 5, results: 1, topScore: 0.5, latencyMs: 100, ...overrides };
}

async function waitForFile(filePath: string, timeoutMs = 1000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const content = await fs.readFile(filePath, "utf8").catch(() => null);
    if (content) return content;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("hashQuery hashes to a 12-char hex digest and never leaks the raw query", () => {
  const hash = hashQuery("Luvish's private query about the acquisition");
  assert.match(hash, /^[0-9a-f]{12}$/);
  assert.notEqual(hash, "Luvish's private query about the acquisition");
  assert.equal(hashQuery("same query"), hashQuery("same query"));
  assert.notEqual(hashQuery("query a"), hashQuery("query b"));
});

test("recordRecallEvent never throws synchronously, even with a bogus config", () => {
  const bogusConfig = { ...({} as HenryConfig), metricsDir: "\0invalid" };
  assert.doesNotThrow(() => recordRecallEvent(bogusConfig, event()));
});

test("planContextInjection traces used, clipped, below-threshold, and budget-truncated hits", () => {
  const first = { id: "first", content: "alpha", source: "a.md", tier: "semantic", score: 0.5, why: "semantic #1" };
  const firstPlan = planContextInjection([first], { charBudget: 10_000, perMemoryChars: 700, minScore: 0.015 });
  const plan = planContextInjection([
    first,
    { id: "weak", content: "beta", source: "b.md", tier: "episodic", score: 0.01, why: "weak" },
    { id: "later", content: "gamma", source: "c.md", tier: "episodic", score: 0.4, why: "later" },
  ], { charBudget: firstPlan.charsUsed + 1, perMemoryChars: 700, minScore: 0.015 });

  assert.equal(plan.usedCount, 1);
  assert.equal(plan.memories.map((memory) => memory.outcome).join(","), "used,below-threshold,truncated");
  assert.equal(plan.text, firstPlan.text);

  const clipped = planContextInjection([
    { ...first, content: "0123456789" },
  ], { charBudget: 10_000, perMemoryChars: 3, minScore: 0.015 });
  assert.equal(clipped.memories[0].outcome, "used");
  assert.equal(clipped.memories[0].clipped, true);
  assert.match(clipped.text, /012… \[truncated; full memory: a\.md\]/);
});

test("recordRecallTrace is privacy-safe, fail-open, and readable newest-first", async () => {
  const config = await tempConfig();
  const trace = {
    ts: new Date().toISOString(), store: "personal" as const, queryHash: "private query",
    k: 8, minScore: 0.015, charBudget: 4000, perMemoryChars: 700, latencyMs: 12,
    returned: 1, used: 1, charsUsed: 42,
    memories: [{ id: "memory-id", score: 0.5, why: "semantic #1", source: "captured/a.md", outcome: "used" as const, content: "secret memory body", excerpt: "secret memory body" }],
    query: "secret raw query",
  } as unknown as RecallTrace & { query: string };
  recordRecallTrace(config, trace);
  const raw = await waitForFile(path.join(config.metricsDir, "recall-traces.jsonl"));
  assert.doesNotMatch(raw, /secret raw query|secret memory body/);
  const parsed = JSON.parse(raw.trim()) as RecallTrace;
  assert.match(parsed.queryHash, /^[0-9a-f]{12}$/);
  assert.equal(parsed.memories[0].id, "memory-id");
  assert.equal("content" in parsed.memories[0], false);

  const traces = await readRecallTraces(config);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].queryHash, parsed.queryHash);

  const bogusConfig = { ...({} as HenryConfig), metricsDir: "\0invalid" };
  assert.doesNotThrow(() => recordRecallTrace(bogusConfig, trace));
});

test("rotateRecallTracesIfNeeded keeps the newest bounded JSONL content", async () => {
  const config = await tempConfig();
  await fs.mkdir(config.metricsDir, { recursive: true });
  const lines = Array.from({ length: TRACE_RETAIN_LINES + 10 }, (_, index) => JSON.stringify({
    ts: new Date(Date.now() + index).toISOString(), store: "personal", queryHash: "abc123def456",
    k: 1, minScore: 0, charBudget: 1, perMemoryChars: 1, latencyMs: 1, returned: 0, used: 0, charsUsed: 0, memories: [],
    padding: "x".repeat(4_000),
  }));
  const tracePath = path.join(config.metricsDir, "recall-traces.jsonl");
  await fs.writeFile(tracePath, `${lines.join("\n")}\n`, "utf8");
  assert.ok((await fs.stat(tracePath)).size > TRACE_FILE_MAX_BYTES);

  await rotateRecallTracesIfNeeded(config);
  assert.ok((await fs.stat(tracePath)).size <= TRACE_FILE_MAX_BYTES);
  const traces = await readRecallTraces(config, 500);
  assert.ok(traces.length <= TRACE_RETAIN_LINES);
  assert.equal(traces[0].ts, JSON.parse(lines.at(-1)!).ts);
});

test("recordRecallEvent appends a JSONL line that summarizeRecallMetrics reads back", async () => {
  const config = await tempConfig();
  recordRecallEvent(config, event({ store: "personal", results: 3, topScore: 0.9 }));
  const content = await waitForFile(path.join(config.metricsDir, "recall-events.jsonl"));
  const parsed = JSON.parse(content.trim().split("\n")[0]) as RecallEvent;
  assert.equal(parsed.store, "personal");
  assert.equal(parsed.results, 3);

  const summary = await summarizeRecallMetrics(config);
  assert.equal(summary.totalAttempts, 1);
  assert.equal(summary.byStore.personal.attempts, 1);
});

test("summarizeRecallMetrics returns nulls (not zeros) and the default shape on an empty log", async () => {
  const config = await tempConfig();
  const summary = await summarizeRecallMetrics(config);
  assert.deepEqual(summary, {
    totalAttempts: 0,
    engineFailures: 0,
    healthyAttempts: 0,
    recallCoverage: null,
    zeroResultRate: null,
    avgReturned: null,
    failureRate: null,
    p50LatencyMs: null,
    p95LatencyMs: null,
    byStore: { personal: { attempts: 0, coverage: null }, knowledge: { attempts: 0, coverage: null } },
    indexFreshness: { personal: null, knowledge: null },
    windowDays: 7,
  });
});

test("summarizeRecallMetrics separates engine failures from zero-result recalls (non-negotiable rule)", async () => {
  const config = await tempConfig();
  await writeEventsFile(config, [
    JSON.stringify(event({ results: 3, latencyMs: 100 })),   // healthy, has results
    JSON.stringify(event({ results: 5, latencyMs: 200 })),   // healthy, has results
    JSON.stringify(event({ results: 0, topScore: null, latencyMs: 150 })), // healthy, zero-result
    JSON.stringify(event({ results: 0, topScore: null, latencyMs: 9999, engineError: "engine timeout" })), // failure — must NOT count as zero-result
    JSON.stringify(event({ results: 0, topScore: null, latencyMs: 8888, engineError: "engine crashed" })), // failure
    JSON.stringify(event({ results: 2, latencyMs: 300 })),   // healthy, has results
  ]);

  const summary = await summarizeRecallMetrics(config, 3650);
  assert.equal(summary.totalAttempts, 6);
  assert.equal(summary.engineFailures, 2);
  assert.equal(summary.healthyAttempts, 4);
  assert.equal(summary.recallCoverage, 3 / 4);
  assert.equal(summary.zeroResultRate, 1 / 4, "the failed events' results:0 must not inflate zeroResultRate");
  assert.equal(summary.avgReturned, 2.5);
  assert.equal(summary.failureRate, 2 / 6);
  // The two failures carry huge latencies (9999, 8888) that would blow up p95 if wrongly
  // included — asserting exact values proves they were excluded from the healthy latency pool.
  assert.equal(summary.p50LatencyMs, 150);
  assert.equal(summary.p95LatencyMs, 300);
});

test("summarizeRecallMetrics tolerates corrupt JSONL lines instead of throwing", async () => {
  const config = await tempConfig();
  await writeEventsFile(config, [
    JSON.stringify(event({ results: 4 })),
    "not json at all {",
    "",
    JSON.stringify({ store: "personal" }), // valid JSON, missing required fields
    JSON.stringify({ ts: "not-a-date", store: "knowledge", k: 5, results: 1, latencyMs: 10, topScore: null }), // invalid ts
    JSON.stringify({ ts: new Date().toISOString(), store: "martian", k: 5, results: 1, latencyMs: 10, topScore: null }), // invalid store enum
    JSON.stringify(event({ results: 6 })),
  ]);

  const summary = await summarizeRecallMetrics(config, 3650);
  assert.equal(summary.totalAttempts, 2);
  assert.equal(summary.avgReturned, 5);
});

test("summarizeRecallMetrics only counts events inside the requested window", async () => {
  const config = await tempConfig();
  const now = new Date().toISOString();
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  await writeEventsFile(config, [
    JSON.stringify(event({ ts: now })),
    JSON.stringify(event({ ts: tenDaysAgo })),
  ]);

  const defaultWindow = await summarizeRecallMetrics(config); // default 7 days
  assert.equal(defaultWindow.totalAttempts, 1);

  const widerWindow = await summarizeRecallMetrics(config, 30);
  assert.equal(widerWindow.totalAttempts, 2);
  assert.equal(widerWindow.windowDays, 30);
});

test("summarizeRecallMetrics groups byStore with independent per-store coverage", async () => {
  const config = await tempConfig();
  await writeEventsFile(config, [
    JSON.stringify(event({ store: "personal", results: 1 })),
    JSON.stringify(event({ store: "personal", results: 0, topScore: null })),
    JSON.stringify(event({ store: "knowledge", results: 4 })),
    JSON.stringify(event({ store: "knowledge", results: 0, topScore: null, engineError: "boom" })),
  ]);

  const summary = await summarizeRecallMetrics(config, 3650);
  assert.deepEqual(summary.byStore.personal, { attempts: 2, coverage: 0.5 });
  assert.deepEqual(summary.byStore.knowledge, { attempts: 2, coverage: 1 });
});

test("summarizeRecallMetrics reports index freshness from db mtimes, null when missing", async () => {
  const config = await tempConfig();
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(config.dbPath, "fake db", "utf8");
  // config.knowledgeDbPath is deliberately left missing.

  const summary = await summarizeRecallMetrics(config);
  const expectedMtime = (await fs.stat(config.dbPath)).mtime.toISOString();
  assert.equal(summary.indexFreshness.personal, expectedMtime);
  assert.equal(summary.indexFreshness.knowledge, null);
});

test("scoreEvalQueries computes precision@5 and MRR from fixture hits", () => {
  const queries: EvalQuery[] = [
    { query: "q1", store: "knowledge", expectModuleContains: ["Alpha Module"] },
    { query: "q2", store: "knowledge", expectModuleContains: ["Gamma Module"] },
    { query: "q3", store: "knowledge", expectModuleContains: ["Nonexistent Module"] },
  ];
  const hitsByQuery = [
    [{ metadata: { module: "Alpha Module Basics" }, source: "a" }, { metadata: { module: "Beta" }, source: "b" }],
    [{ metadata: { module: "Beta" }, source: "b" }, { metadata: { module: "Delta" }, source: "d" }, { metadata: { module: "Gamma Module Advanced" }, source: "g" }],
    [{ metadata: { module: "Beta" }, source: "b" }],
  ];

  const report = scoreEvalQueries(queries, hitsByQuery);
  assert.equal(report.queryCount, 3);
  assert.equal(report.results[0].pass, true);
  assert.equal(report.results[0].rank, 1);
  assert.equal(report.results[1].pass, true);
  assert.equal(report.results[1].rank, 3);
  assert.equal(report.results[2].pass, false);
  assert.equal(report.results[2].rank, null);
  assert.equal(report.precisionAt5, 2 / 3);
  const expectedMrr = (1 / 1 + 1 / 3 + 0) / 3;
  assert.ok(Math.abs((report.mrr ?? NaN) - expectedMrr) < 1e-9);
});

test("scoreEvalQueries treats an engine error as an automatic fail, still counted in the denominator", () => {
  const queries: EvalQuery[] = [{ query: "q1", store: "knowledge", expectModuleContains: ["X"] }];
  const report = scoreEvalQueries(queries, [[]], ["engine exploded"]);
  assert.equal(report.results[0].pass, false);
  assert.equal(report.results[0].rank, null);
  assert.equal(report.results[0].error, "engine exploded");
  assert.equal(report.queryCount, 1);
  assert.equal(report.precisionAt5, 0);
});

test("scoreEvalQueries returns null precision/MRR for an empty query set (no 0/0 NaN)", () => {
  const report = scoreEvalQueries([], []);
  assert.equal(report.queryCount, 0);
  assert.equal(report.precisionAt5, null);
  assert.equal(report.mrr, null);
});

test("scoreEvalQueries matches case-insensitively and accepts any one of several expected substrings", () => {
  const queries: EvalQuery[] = [{ query: "q1", store: "knowledge", expectModuleContains: ["zzz-no-match", "PRODUCT STRATEGY"] }];
  const hits = [[{ metadata: { module: "Mastering product strategy" }, source: "s" }]];
  const report = scoreEvalQueries(queries, hits);
  assert.equal(report.results[0].pass, true);
  assert.equal(report.results[0].rank, 1);
});
