import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { importKnowledge } from "../src/knowledge/importer.ts";
import type { KnowledgeBase, KnowledgeEntry } from "../src/knowledge/store.ts";
import type { ProviderRunner } from "../src/providers/runner.ts";
import type { RunResult } from "../src/types.ts";

async function setup(): Promise<{ config: ReturnType<typeof loadConfig>; rootDir: string }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-import-"));
  return { config: loadConfig(rootDir), rootDir };
}

/** Fake KnowledgeBase — importKnowledge only calls add(); avoid loading the real embedding model in tests. */
function fakeKb(): { kb: KnowledgeBase; added: KnowledgeEntry[] } {
  const added: KnowledgeEntry[] = [];
  const kb = {
    add: async (entry: KnowledgeEntry) => { added.push(entry); return `id-${added.length}`; },
  } as unknown as KnowledgeBase;
  return { kb, added };
}

function cardsRunner(cards: Array<Record<string, unknown>>): ProviderRunner {
  return {
    run: async (): Promise<RunResult> => ({
      runId: "run", provider: "claude", exitCode: 0, durationMs: 1, events: [],
      response: JSON.stringify({ cards }),
    }),
  } as unknown as ProviderRunner;
}

test("importKnowledge chunks+indexes a markdown file with the contextual-retrieval prefix and raw metadata", async () => {
  const { config, rootDir } = await setup();
  const { kb, added } = fakeKb();
  const srcDir = await fs.mkdtemp(path.join(rootDir, "src-"));
  const filePath = path.join(srcDir, "onboarding-notes.md");
  await fs.writeFile(filePath, "# Onboarding\n\nWelcome checklist: verify workspace access on day one.", "utf8");

  const report = await importKnowledge(config, kb, [filePath], { sourceName: "unit-test-batch" });

  assert.equal(report.files, 1);
  assert.equal(report.chunks, 1, "short content fits in a single chunk");
  assert.equal(report.cards, 0, "distill was not requested");
  assert.deepEqual(report.skipped, []);
  assert.equal(added.length, 1);

  const entry = added[0];
  assert.equal(entry.content, "onboarding-notes (part 1)\n# Onboarding\nWelcome checklist: verify workspace access on day one.");
  assert.equal(entry.source, "imported/unit-test-batch/onboarding-notes.md#1");
  assert.equal(entry.metadata.layer, "raw");
  assert.equal(entry.metadata.module, "onboarding-notes");
  assert.equal(entry.metadata.source, "imported/unit-test-batch/onboarding-notes.md#1");
  assert.equal(entry.metadata.imported, true);
  assert.equal(entry.metadata.batch, "unit-test-batch");
  assert.ok(typeof entry.metadata.domain === "string" && entry.metadata.domain.length > 0);
  assert.deepEqual(report.byDomain, { [entry.metadata.domain as string]: 1 });

  // Provenance copy landed under knowledge/raw/imported/<batch>/.
  const copied = await fs.readFile(path.join(config.knowledgeDir, "raw", "imported", "unit-test-batch", "onboarding-notes.md"), "utf8");
  assert.match(copied, /Welcome checklist/);
});

test("importKnowledge recurses directories, skipping hidden entries and node_modules", async () => {
  const { config, rootDir } = await setup();
  const { kb, added } = fakeKb();
  const contentDir = path.join(rootDir, "content");
  await fs.mkdir(path.join(contentDir, "sub"), { recursive: true });
  await fs.mkdir(path.join(contentDir, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(contentDir, "a.md"), "Top-level note about growth channels for a small startup team.", "utf8");
  await fs.writeFile(path.join(contentDir, "sub", "b.txt"), "Nested note about community engagement tactics for members.", "utf8");
  await fs.writeFile(path.join(contentDir, ".hidden.md"), "Should never be picked up by the walker.", "utf8");
  await fs.writeFile(path.join(contentDir, "node_modules", "pkg", "c.md"), "Should never be picked up either.", "utf8");

  const report = await importKnowledge(config, kb, [contentDir], { sourceName: "recursive-batch" });

  assert.equal(report.files, 2, "only a.md and sub/b.txt should be discovered");
  assert.deepEqual(report.skipped, []);
  const modules = added.map((entry) => entry.metadata.module).sort();
  assert.deepEqual(modules, ["a", "b"]);
  assert.ok(!added.some((entry) => entry.content.includes("never be picked up")), "hidden/node_modules content must never reach the KB");
  const domainSum = Object.values(report.byDomain).reduce((sum, n) => sum + n, 0);
  assert.equal(domainSum, report.chunks, "byDomain must partition all indexed chunks");
});

test("importKnowledge skips an unsupported file extension with a clear reason", async () => {
  const { config, rootDir } = await setup();
  const { kb, added } = fakeKb();
  const filePath = path.join(rootDir, "data.json");
  await fs.writeFile(filePath, '{"not":"markdown"}', "utf8");

  const report = await importKnowledge(config, kb, [filePath], { sourceName: "ext-batch" });

  assert.equal(report.files, 0);
  assert.equal(report.chunks, 0);
  assert.equal(added.length, 0);
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0].path, filePath);
  assert.match(report.skipped[0].reason, /unsupported file extension/);
});

test("importKnowledge lets an explicit domain option override per-chunk derivation", async () => {
  const { config, rootDir } = await setup();
  const { kb, added } = fakeKb();
  const filePath = path.join(rootDir, "marketing-notes.md");
  // Content alone would derive to "growth-strategy" (matches /growth|acquisition|retention|funnel|marketing/).
  await fs.writeFile(filePath, "# Growth funnel tactics\n\nCheap acquisition and retention channels for early marketing.", "utf8");

  const withoutOverride = await importKnowledge(config, fakeKb().kb, [filePath], { sourceName: "no-override" });
  assert.equal(Object.keys(withoutOverride.byDomain)[0], "growth-strategy", "sanity check: heuristic derivation picks growth-strategy here");

  const report = await importKnowledge(config, kb, [filePath], { sourceName: "override-batch", domain: "careers" });

  assert.equal(report.files, 1);
  assert.ok(added.every((entry) => entry.metadata.domain === "careers"), "every chunk must carry the explicit override");
  assert.deepEqual(report.byDomain, { careers: report.chunks });
});

test("importKnowledge reports a clear skip reason when pdftotext is missing from PATH", async () => {
  const { config, rootDir } = await setup();
  const { kb, added } = fakeKb();
  const filePath = path.join(rootDir, "whitepaper.pdf");
  await fs.writeFile(filePath, "not a real pdf, but extension routing happens before content is read", "utf8");

  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const report = await importKnowledge(config, kb, [filePath], { sourceName: "pdf-batch" });
    assert.equal(report.files, 0);
    assert.equal(added.length, 0);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].path, filePath);
    assert.match(report.skipped[0].reason, /pdftotext/);
    assert.match(report.skipped[0].reason, /brew install poppler/);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("importKnowledge distills strategy cards per file when distill=true and a runner is provided", async () => {
  const { config, rootDir } = await setup();
  const { kb, added } = fakeKb();
  const filePath = path.join(rootDir, "channel-playbook.md");
  await fs.writeFile(filePath, "# Channel playbook\n\nRun small paid pilots before committing budget to a channel.", "utf8");

  const runner = cardsRunner([{
    title: "Pilot before you scale",
    claim: "Run a small paid pilot before committing full budget to a channel.",
    whenToUse: "Testing a new acquisition channel",
    steps: ["Set a capped test budget", "Measure CAC after the pilot"],
    evidence: "Quoted from the source material",
    domain: "growth-strategy",
    tags: ["paid-acquisition"],
  }]);

  const report = await importKnowledge(config, kb, [filePath], { sourceName: "card-batch", distill: true, runner });

  assert.equal(report.files, 1);
  assert.equal(report.chunks, 1, "raw indexing still happens alongside distillation");
  assert.equal(report.cards, 1);

  const cardEntry = added.find((entry) => entry.metadata.layer === "card");
  assert.ok(cardEntry, "expected one card-layer add() call");
  assert.match(cardEntry!.content, /Pilot before you scale/);
  assert.equal(cardEntry!.metadata.module, "channel-playbook");
  assert.equal(cardEntry!.metadata.imported, true);
  assert.equal(cardEntry!.metadata.batch, "card-batch");
  assert.equal(cardEntry!.importance, 8);

  const cardFile = path.join(config.knowledgeDir, "cards", "imported-card-batch-channel-playbook-1.md");
  const rendered = await fs.readFile(cardFile, "utf8");
  assert.match(rendered, /Pilot before you scale/);
  assert.match(rendered, /Set a capped test budget/);
});

test("importKnowledge leaves distillation off (fail-open) when distill=true but no runner is given", async () => {
  const { config, rootDir } = await setup();
  const { kb, added } = fakeKb();
  const filePath = path.join(rootDir, "no-runner.md");
  await fs.writeFile(filePath, "Some plausible content that would otherwise be distilled into cards.", "utf8");

  const report = await importKnowledge(config, kb, [filePath], { sourceName: "no-runner-batch", distill: true });

  assert.equal(report.cards, 0);
  assert.equal(report.files, 1, "raw indexing still succeeds even though distill was requested without a runner");
  assert.ok(!added.some((entry) => entry.metadata.layer === "card"));
});
