import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { HenryConfig } from "../config.ts";

/**
 * Recall measurement layer (docs/dashboard-design-v2.md §C). Every recall attempt across both
 * stores (personal Engram + knowledge base) emits one `RecallEvent` to a local, append-only
 * JSONL log; `summarizeRecallMetrics` aggregates that log into the numbers the mission-control
 * memory-health strip (§B2) and a future `/api/engram/metrics` route read. Local-only. Never
 * stores raw query text for the personal store — only a short hash (queryHash).
 */
export interface RecallEvent {
  ts: string;
  store: "personal" | "knowledge";
  queryHash: string;
  k: number;
  results: number;
  topScore: number | null;
  latencyMs: number;
  engineError?: string;
}

function eventsPath(config: HenryConfig): string {
  return path.join(config.metricsDir, "recall-events.jsonl");
}

/** sha256 of the query, first 12 hex chars — enough to dedupe/correlate without storing raw text. */
export function hashQuery(query: string): string {
  return createHash("sha256").update(query).digest("hex").slice(0, 12);
}

/**
 * Appends one recall event to `data/metrics/recall-events.jsonl`. Fire-and-forget by design: a
 * metrics write must never be the reason a recall call fails (fail-open, module-doctrine #6),
 * so this returns synchronously and swallows every error itself, including from the background
 * write.
 */
export function recordRecallEvent(config: HenryConfig, event: RecallEvent): void {
  try {
    const line = `${JSON.stringify(event)}\n`;
    void fs.mkdir(config.metricsDir, { recursive: true, mode: 0o700 })
      .then(() => fs.appendFile(eventsPath(config), line, "utf8"))
      .catch(() => undefined);
  } catch {
    // Never throw — a metrics failure must never break a recall call.
  }
}

/* ---------------------------------------------------------------------------
 * Recall traces — the used-vs-dropped record.
 *
 * A RecallEvent above answers "did a recall happen, how fast, how many hits".
 * It cannot answer the question that actually matters when Henry replies oddly:
 * of the memories that came back, which ones reached the prompt and which were
 * thrown away on the way there? `HenryMemory.context()` drops hits under
 * `minScore` and stops at a character budget, and until now both decisions were
 * invisible. A RecallTrace records one context-injection decision: the budget
 * that was in force, plus one row per returned memory with its outcome.
 *
 * PRIVACY RAIL (deliberate, do not reverse): like RecallEvent, a trace stores no
 * raw query text and no memory content/excerpt — only the query hash, memory
 * ids, scores, engram's own `why` string, the source path, and the outcome.
 * `sanitizeTrace` below rebuilds every record field-by-field from that allowlist
 * before it is serialized, so content can never reach disk even if a future
 * caller passes it in. There is deliberately no raw-text mode, opt-in or
 * otherwise: `source` plus `id` is enough to open the memory on disk.
 * ------------------------------------------------------------------------- */

/** used = in the context block · below-threshold = lost to minScore · truncated = lost to the char budget. */
export type RecallTraceOutcome = "used" | "below-threshold" | "truncated";

export interface RecallTraceMemory {
  id: string;
  score: number;
  /** Engram's structural explanation ("semantic #1 (0.62) · importance 9.00"), never memory content. */
  why: string;
  source: string | null;
  outcome: RecallTraceOutcome;
  /** Used, but its body was clipped to perMemoryChars — the memory still reached the prompt. */
  clipped?: boolean;
}

export interface RecallTrace {
  ts: string;
  store: "personal" | "knowledge";
  queryHash: string;
  k: number;
  minScore: number;
  charBudget: number;
  perMemoryChars: number;
  latencyMs: number;
  /** Memories the engine returned (before minScore/budget filtering). */
  returned: number;
  /** Memories that reached the context block. */
  used: number;
  charsUsed: number;
  memories: RecallTraceMemory[];
}

/** Rows kept per trace; a `k` far above this is pathological, and the file stays bounded. */
export const TRACE_MAX_MEMORIES = 32;
const TRACE_WHY_MAX_CHARS = 200;
const TRACE_SOURCE_MAX_CHARS = 240;
/** Rotation: once the JSONL passes this size, only the newest TRACE_RETAIN_LINES traces survive. */
export const TRACE_FILE_MAX_BYTES = 1_000_000;
export const TRACE_RETAIN_LINES = 300;

function tracesPath(config: HenryConfig): string {
  return path.join(config.metricsDir, "recall-traces.jsonl");
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sanitizeTraceMemory(memory: RecallTraceMemory): RecallTraceMemory {
  const outcome: RecallTraceOutcome = memory?.outcome === "used" || memory?.outcome === "truncated"
    ? memory.outcome
    : "below-threshold";
  const source = typeof memory?.source === "string" ? memory.source.slice(0, TRACE_SOURCE_MAX_CHARS) : null;
  return {
    id: String(memory?.id ?? "").slice(0, 128),
    score: finite(memory?.score),
    why: typeof memory?.why === "string" ? memory.why.slice(0, TRACE_WHY_MAX_CHARS) : "",
    source,
    outcome,
    ...(memory?.clipped === true ? { clipped: true } : {}),
  };
}

/**
 * The privacy boundary. Every stored trace is rebuilt from this field allowlist, so an
 * unexpected `content`/`query`/`excerpt` property on the caller's object is dropped rather
 * than written. A queryHash that isn't already a hex digest is re-hashed here rather than
 * trusted — a caller who mistakenly passes raw text still cannot leak it to disk.
 */
function sanitizeTrace(trace: RecallTrace): RecallTrace {
  const rawHash = String(trace?.queryHash ?? "");
  const memories = Array.isArray(trace?.memories) ? trace.memories : [];
  return {
    ts: typeof trace?.ts === "string" && !Number.isNaN(Date.parse(trace.ts)) ? trace.ts : new Date().toISOString(),
    store: trace?.store === "knowledge" ? "knowledge" : "personal",
    // hashQuery() always emits exactly 12 lowercase hex characters. Re-hash every
    // other shape, including short/all-hex strings, so a caller cannot accidentally
    // persist a raw query in the queryHash field.
    queryHash: /^[0-9a-f]{12}$/.test(rawHash) ? rawHash : hashQuery(rawHash),
    k: finite(trace?.k),
    minScore: finite(trace?.minScore),
    charBudget: finite(trace?.charBudget),
    perMemoryChars: finite(trace?.perMemoryChars),
    latencyMs: finite(trace?.latencyMs),
    returned: finite(trace?.returned),
    used: finite(trace?.used),
    charsUsed: finite(trace?.charsUsed),
    memories: memories.slice(0, TRACE_MAX_MEMORIES).map(sanitizeTraceMemory),
  };
}

// One serialized write chain per trace file: an append and a rotation rewrite must never
// interleave (a rotation reads-then-replaces the whole file). Every link swallows its own
// error so one bad write never poisons later ones — same fail-open contract as recordRecallEvent.
const traceWriteChains = new Map<string, Promise<void>>();

function queueTraceWrite(filePath: string, operation: () => Promise<void>): void {
  const previous = traceWriteChains.get(filePath) ?? Promise.resolve();
  const next = previous.then(operation).catch(() => undefined);
  traceWriteChains.set(filePath, next);
  void next.then(() => { if (traceWriteChains.get(filePath) === next) traceWriteChains.delete(filePath); });
}

/**
 * Caps the trace log: past TRACE_FILE_MAX_BYTES, rewrite it with only the newest
 * TRACE_RETAIN_LINES traces (write-temp-then-rename, so a crash mid-rotation never leaves a
 * half-file in place). Exported so the cap is testable without writing a megabyte through
 * recordRecallTrace. Never throws.
 */
export async function rotateRecallTracesIfNeeded(config: HenryConfig): Promise<void> {
  try {
    const filePath = tracesPath(config);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat || stat.size <= TRACE_FILE_MAX_BYTES) return;
    const raw = await fs.readFile(filePath, "utf8").catch(() => null);
    if (raw === null) return;
    const candidates = raw.split("\n").filter((line) => line.trim()).slice(-TRACE_RETAIN_LINES);
    // Keep the newest lines that fit the byte cap. The normal sanitized line is
    // small, but this also makes rotation safe if an older/corrupt line is huge.
    const kept: string[] = [];
    let keptBytes = 0;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const lineBytes = Buffer.byteLength(candidates[index], "utf8") + 1;
      if (lineBytes > TRACE_FILE_MAX_BYTES || keptBytes + lineBytes > TRACE_FILE_MAX_BYTES) continue;
      kept.unshift(candidates[index]);
      keptBytes += lineBytes;
    }
    const tempPath = `${filePath}.rotate`;
    await fs.writeFile(tempPath, kept.length ? `${kept.join("\n")}\n` : "", { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempPath, filePath);
  } catch {
    // A rotation failure is never worth surfacing; the next write retries.
  }
}

/**
 * Appends one trace to `data/metrics/recall-traces.jsonl`. Fire-and-forget with exactly the
 * same contract as recordRecallEvent: returns synchronously, swallows every error including
 * from the background write, and can never make a recall slower or fail.
 */
export function recordRecallTrace(config: HenryConfig, trace: RecallTrace): void {
  try {
    const line = `${JSON.stringify(sanitizeTrace(trace))}\n`;
    const filePath = tracesPath(config);
    queueTraceWrite(filePath, async () => {
      await fs.mkdir(config.metricsDir, { recursive: true, mode: 0o700 });
      await fs.appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
      await rotateRecallTracesIfNeeded(config);
    });
  } catch {
    // Never throw — a trace failure must never break a recall call.
  }
}

/** Newest-first, tolerant read (same rules as readEvents): missing file = none, bad line = skipped. */
export async function readRecallTraces(config: HenryConfig, limit = 50): Promise<RecallTrace[]> {
  const raw = await fs.readFile(tracesPath(config), "utf8").catch(() => "");
  const traces: RecallTrace[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as RecallTrace;
      if (!parsed || typeof parsed !== "object" || typeof parsed.ts !== "string" || Number.isNaN(Date.parse(parsed.ts))) continue;
      traces.push(sanitizeTrace(parsed)); // sanitize on read too: an old/edited line can't smuggle extra fields to the UI
    } catch {
      continue;
    }
  }
  const capped = Math.max(1, Math.min(500, Math.floor(limit) || 50));
  return traces.slice(-capped).reverse();
}

/* --- context-injection planning (the one place used/dropped is decided) --- */

/** The subset of engram's RecallResult this module needs; declared structurally so recall-metrics stays dependency-free. */
export interface ContextCandidate {
  id: string;
  content: string;
  source: string | null;
  tier: string | null;
  score: number;
  why: string;
}

export interface ContextBudget {
  charBudget: number;
  perMemoryChars: number;
  minScore: number;
}

export interface ContextPlan {
  /** The context block exactly as it will be injected. */
  text: string;
  charsUsed: number;
  usedCount: number;
  /** One row per candidate, in engine rank order, classified used/below-threshold/truncated. */
  memories: RecallTraceMemory[];
}

/**
 * Builds the context block AND its trace rows in one pass — deliberately the same loop, so the
 * trace can never claim a memory was used that the prompt never saw. Order of the two drops
 * mirrors HenryMemory.context() exactly: a hit under `minScore` is below-threshold wherever it
 * ranks, and once a block would overflow `charBudget` that block and every later surviving hit
 * are `truncated` (the original loop simply broke there). A memory whose body is clipped to
 * `perMemoryChars` is still `used` — clipped, not dropped.
 */
export function planContextInjection(results: readonly ContextCandidate[], budget: ContextBudget): ContextPlan {
  const blocks: string[] = [];
  const memories: RecallTraceMemory[] = [];
  let charsUsed = 0;
  let budgetExhausted = false;

  for (const result of results) {
    const row = { id: String(result.id), score: result.score, why: result.why ?? "", source: result.source ?? null };
    if (!(result.score >= budget.minScore)) {
      memories.push({ ...row, outcome: "below-threshold" });
      continue;
    }
    if (budgetExhausted) {
      memories.push({ ...row, outcome: "truncated" });
      continue;
    }
    const clipped = result.content.length > budget.perMemoryChars;
    const body = clipped
      ? `${result.content.slice(0, budget.perMemoryChars)}… [truncated; full memory: ${result.source}]`
      : result.content;
    const block = `[memory ${result.id} · ${result.tier ?? "episodic"} · why: ${result.why ?? "relevant"}]
${body}`;
    if (charsUsed + block.length > budget.charBudget) {
      budgetExhausted = true;
      memories.push({ ...row, outcome: "truncated" });
      continue;
    }
    blocks.push(block);
    charsUsed += block.length;
    memories.push({ ...row, outcome: "used", ...(clipped ? { clipped: true } : {}) });
  }

  return { text: blocks.join("\n\n"), charsUsed, usedCount: blocks.length, memories };
}

export interface MetricsSummary {
  totalAttempts: number;
  engineFailures: number;
  healthyAttempts: number;
  recallCoverage: number | null;
  zeroResultRate: number | null;
  avgReturned: number | null;
  failureRate: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  byStore: Record<string, { attempts: number; coverage: number | null }>;
  indexFreshness: { personal: string | null; knowledge: string | null };
  windowDays: number;
}

/** Tolerant JSONL reader: a missing file reads as no events; malformed/short-shaped lines are skipped, never fatal. */
async function readEvents(config: HenryConfig): Promise<RecallEvent[]> {
  const raw = await fs.readFile(eventsPath(config), "utf8").catch(() => "");
  const events: RecallEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<RecallEvent>;
      const validShape = typeof parsed.ts === "string" && !Number.isNaN(Date.parse(parsed.ts))
        && (parsed.store === "personal" || parsed.store === "knowledge")
        && typeof parsed.k === "number" && typeof parsed.results === "number" && typeof parsed.latencyMs === "number";
      if (!validShape) continue;
      events.push({
        ts: parsed.ts as string, store: parsed.store as "personal" | "knowledge",
        queryHash: String(parsed.queryHash ?? ""), k: parsed.k as number, results: parsed.results as number,
        topScore: typeof parsed.topScore === "number" ? parsed.topScore : null,
        latencyMs: parsed.latencyMs as number,
        ...(typeof parsed.engineError === "string" ? { engineError: parsed.engineError } : {}),
      });
    } catch {
      continue; // one corrupt line never sinks the whole read
    }
  }
  return events;
}

/** Nearest-rank percentile over an ascending-sorted array (1-indexed rank = ceil(p/100 * n)). */
function percentile(sortedAsc: number[], p: number): number | null {
  if (!sortedAsc.length) return null;
  const rank = Math.min(sortedAsc.length, Math.max(1, Math.ceil((p / 100) * sortedAsc.length)));
  return sortedAsc[rank - 1];
}

async function mtimeIso(filePath: string): Promise<string | null> {
  return fs.stat(filePath).then((stat) => stat.mtime.toISOString()).catch(() => null);
}

/**
 * Aggregates the recall-event log into the Friday-brief metrics (docs/dashboard-design-v2.md §C).
 * Formulas — null (never 0) when their denominator is 0:
 *   healthy        = total - engineFailures
 *   recallCoverage = (healthy attempts with >=1 result) / healthy
 *   zeroResultRate = (healthy attempts with 0 results) / healthy
 *   avgReturned    = sum(results over healthy) / healthy
 *   failureRate    = engineFailures / total
 * Engine failures are never counted as zero-result recalls — they're excluded from the healthy
 * pool entirely before coverage/zeroResultRate/avgReturned/latency percentiles are computed
 * (non-negotiable, per the design doc). p50/p95 run over healthy latencies only.
 */
export async function summarizeRecallMetrics(config: HenryConfig, windowDays = 7): Promise<MetricsSummary> {
  const all = await readEvents(config);
  const since = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const events = all.filter((event) => Date.parse(event.ts) >= since);

  const healthy = events.filter((event) => !event.engineError);
  const engineFailures = events.length - healthy.length;
  const healthyAttempts = healthy.length;
  const withResult = healthy.filter((event) => event.results >= 1).length;
  const zeroResult = healthy.filter((event) => event.results === 0).length;

  const byStore: Record<string, { attempts: number; coverage: number | null }> = {
    personal: { attempts: 0, coverage: null },
    knowledge: { attempts: 0, coverage: null },
  };
  for (const store of new Set(events.map((event) => event.store))) {
    const storeHealthy = events.filter((event) => event.store === store && !event.engineError);
    const storeWithResult = storeHealthy.filter((event) => event.results >= 1).length;
    byStore[store] = {
      attempts: events.filter((event) => event.store === store).length,
      coverage: storeHealthy.length ? storeWithResult / storeHealthy.length : null,
    };
  }

  const latencies = healthy.map((event) => event.latencyMs).sort((a, b) => a - b);

  return {
    totalAttempts: events.length,
    engineFailures,
    healthyAttempts,
    recallCoverage: healthyAttempts ? withResult / healthyAttempts : null,
    zeroResultRate: healthyAttempts ? zeroResult / healthyAttempts : null,
    avgReturned: healthyAttempts ? healthy.reduce((sum, event) => sum + event.results, 0) / healthyAttempts : null,
    failureRate: events.length ? engineFailures / events.length : null,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    byStore,
    indexFreshness: {
      personal: await mtimeIso(config.dbPath),
      knowledge: await mtimeIso(config.knowledgeDbPath),
    },
    windowDays,
  };
}
