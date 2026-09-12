import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { KnowledgeIngestor } from "../src/knowledge/ingest.ts";
import type { KnowledgeBase, KnowledgeEntry } from "../src/knowledge/store.ts";
import type { ProviderRunner, RunOptions } from "../src/providers/runner.ts";
import type { RunResult } from "../src/types.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Writes one frontmatter-tagged transcript file so collectRawEntries() picks it up as its own module. */
async function writeModule(rawDir: string, moduleId: string, moduleName: string): Promise<void> {
  const dir = path.join(rawDir, "texts");
  await fs.mkdir(dir, { recursive: true });
  const body = `Body content for ${moduleName}. Sentence one. Sentence two. Sentence three describing the tactic.`;
  const file = [
    "---",
    `module: "${moduleName}"`,
    `moduleId: "${moduleId}"`,
    "---",
    "",
    body,
    "",
  ].join("\n");
  await fs.writeFile(path.join(dir, `${moduleId}.md`), file, "utf8");
}

function validCardsResponse(): string {
  return JSON.stringify([
    { claim: "Do the tactic", whenToUse: "When relevant", steps: ["Step one"], evidence: "Quoted evidence" },
  ]);
}

interface TrackingRunner {
  runner: ProviderRunner;
  maxInFlight: () => number;
  calls: () => Array<{ prompt: string; options: RunOptions }>;
}

/**
 * Fake ProviderRunner whose run() sleeps for `delayMs` before resolving, tracking how many
 * calls are concurrently in-flight. `respond` lets individual tests fail/short-circuit specific
 * modules (matched by prompt content) to exercise the per-module try/catch paths.
 */
function trackingRunner(
  delayMs: number,
  respond: (prompt: string) => { response: string; exitCode: number; throw?: boolean } = () => ({ response: validCardsResponse(), exitCode: 0 }),
): TrackingRunner {
  let inFlight = 0;
  let max = 0;
  const calls: Array<{ prompt: string; options: RunOptions }> = [];
  const runner = {
    run: async (prompt: string, options: RunOptions = {}): Promise<RunResult> => {
      calls.push({ prompt, options });
      inFlight += 1;
      max = Math.max(max, inFlight);
      try {
        await sleep(delayMs);
        const outcome = respond(prompt);
        if (outcome.throw) throw new Error("simulated provider crash");
        return { runId: "run", provider: "claude", response: outcome.response, exitCode: outcome.exitCode, durationMs: delayMs, events: [] };
      } finally {
        inFlight -= 1;
      }
    },
  } as unknown as ProviderRunner;
  return { runner, maxInFlight: () => max, calls: () => calls };
}

/** Fake KnowledgeBase — ingestCards only calls add(); avoid loading the real embedding model in tests. */
function fakeKb(): KnowledgeBase {
  const added: KnowledgeEntry[] = [];
  return {
    add: async (entry: KnowledgeEntry) => { added.push(entry); return `id-${added.length}`; },
  } as unknown as KnowledgeBase;
}

async function setup(): Promise<{ config: ReturnType<typeof loadConfig>; activity: ActivityLog; rawDir: string; cardsDir: string }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-ingest-cards-"));
  const config = loadConfig(rootDir);
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  const rawDir = path.join(config.knowledgeDir, "raw");
  const cardsDir = path.join(config.knowledgeDir, "cards");
  return { config, activity, rawDir, cardsDir };
}

test("ingestCards runs provider calls for distinct modules concurrently, up to the default cap of 3", async () => {
  const { config, activity, rawDir, cardsDir } = await setup();
  for (let i = 0; i < 6; i += 1) await writeModule(rawDir, `mod-${i}`, `Module ${i}`);

  const { runner, maxInFlight } = trackingRunner(40);
  const ingestor = new KnowledgeIngestor(config, activity, fakeKb(), runner);
  const report = await ingestor.ingestCards({ limit: 6 });

  assert.equal(report.modules, 6, "all six modules should have distilled successfully");
  assert.equal(report.failed, 0);
  assert.equal(report.cards, 6, "one card per module in the fake response");
  // 6 pending modules with a pool of 3 workers and a uniform delay guarantees the first
  // wave of 3 calls overlaps in flight.
  assert.equal(maxInFlight(), 3, "expected exactly 3 provider calls in flight at once (default concurrency)");

  const checkpoint = JSON.parse(await fs.readFile(path.join(cardsDir, ".distilled.json"), "utf8")) as string[];
  assert.equal(checkpoint.length, 6);
  assert.equal(new Set(checkpoint).size, 6, "checkpoint must not contain duplicate module keys");
});

test("ingestCards caps concurrency at 3 even when a caller requests more (M1 policy, MASTER_PLAN §7)", async () => {
  const { config, activity, rawDir } = await setup();
  for (let i = 0; i < 6; i += 1) await writeModule(rawDir, `mod-${i}`, `Module ${i}`);

  const { runner, maxInFlight } = trackingRunner(40);
  const ingestor = new KnowledgeIngestor(config, activity, fakeKb(), runner);
  const report = await ingestor.ingestCards({ limit: 6, concurrency: 10 });

  assert.equal(report.modules, 6);
  assert.ok(maxInFlight() <= 3, `expected in-flight calls capped at 3, saw ${maxInFlight()}`);
  assert.equal(maxInFlight(), 3, "the pool should still saturate at the hard cap of 3");
});

test("ingestCards checkpoint stays intact and non-duplicated under concurrent completions", async () => {
  const { config, activity, rawDir, cardsDir } = await setup();
  const moduleIds = Array.from({ length: 9 }, (_, i) => `mod-${i}`);
  for (const id of moduleIds) await writeModule(rawDir, id, `Module ${id}`);

  // Staggered delays so workers finish out of submission order, maximizing the chance
  // of a checkpoint race if the mutex were missing.
  let call = 0;
  const runner = {
    run: async (prompt: string): Promise<RunResult> => {
      const delay = 5 + ((call += 1) % 4) * 15;
      await sleep(delay);
      return { runId: "run", provider: "claude", response: validCardsResponse(), exitCode: 0, durationMs: delay, events: [] };
    },
  } as unknown as ProviderRunner;

  const ingestor = new KnowledgeIngestor(config, activity, fakeKb(), runner);
  const report = await ingestor.ingestCards({ limit: 9 });

  assert.equal(report.modules, 9);
  assert.equal(report.failed, 0);

  const raw = await fs.readFile(path.join(cardsDir, ".distilled.json"), "utf8");
  const checkpoint = JSON.parse(raw) as string[]; // throws if a torn/interleaved write corrupted the JSON
  assert.equal(checkpoint.length, 9, "no module dropped and none double-counted");
  assert.equal(new Set(checkpoint).size, 9, "no duplicate entries from a lost update");
  for (const id of moduleIds) assert.ok(checkpoint.includes(id), `checkpoint missing ${id}`);
});

test("ingestCards isolates per-module failures: one module failing does not abort the batch", async () => {
  const { config, activity, rawDir, cardsDir } = await setup();
  for (let i = 0; i < 5; i += 1) await writeModule(rawDir, `mod-${i}`, `Module ${i}`);

  const { runner } = trackingRunner(10, (prompt) => {
    if (prompt.includes("module: Module 1")) return { throw: true, response: "", exitCode: 0 };
    if (prompt.includes("module: Module 2")) return { response: "not json at all", exitCode: 0 };
    if (prompt.includes("module: Module 3")) return { response: validCardsResponse(), exitCode: 1 };
    return { response: validCardsResponse(), exitCode: 0 };
  });

  const ingestor = new KnowledgeIngestor(config, activity, fakeKb(), runner);
  const report = await ingestor.ingestCards({ limit: 5 });

  assert.equal(report.modules, 2, "only the two clean modules (0 and 4) should succeed");
  assert.equal(report.failed, 3, "thrown error, malformed JSON, and non-zero exit code each count as a failure");

  const checkpoint = JSON.parse(await fs.readFile(path.join(cardsDir, ".distilled.json"), "utf8")) as string[];
  assert.equal(checkpoint.length, 2);
  assert.ok(checkpoint.includes("mod-0"));
  assert.ok(checkpoint.includes("mod-4"));
  assert.ok(!checkpoint.includes("mod-1") && !checkpoint.includes("mod-2") && !checkpoint.includes("mod-3"), "failed modules stay pending for retry, not marked done");
});
