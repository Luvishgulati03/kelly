import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { richTextToPlain } from "../src/knowledge/adapters/org-mongo.ts";
import { deriveDomain } from "../src/knowledge/ingest.ts";
import { KnowledgeBase } from "../src/knowledge/store.ts";

test("richTextToPlain flattens a Quill Delta into prose", () => {
  const delta = JSON.stringify({ ops: [{ insert: "Hello world" }] });
  assert.equal(richTextToPlain(delta), "Hello world");
});

test("richTextToPlain flattens a Lexical document into prose", () => {
  const lexical = JSON.stringify({ root: { children: [{ text: "Hello" }, { text: "world" }] } });
  assert.equal(richTextToPlain(lexical), "Hello world");
});

test("richTextToPlain passes plain text straight through", () => {
  assert.equal(richTextToPlain(" Just a plain string \n"), "Just a plain string");
  assert.equal(richTextToPlain(""), "");
});

test("richTextToPlain passes malformed JSON through unchanged (trimmed)", () => {
  assert.equal(richTextToPlain(" {not valid json "), "{not valid json");
});

test("deriveDomain maps free-form hints onto the knowledge taxonomy", () => {
  assert.equal(deriveDomain(["Go-to-market playbook"]), "gtm");
  assert.equal(deriveDomain(["Product roadmap discovery"]), "product-management");
  assert.equal(deriveDomain(["Software engineering module", "api design"]), "software-development");
  assert.equal(deriveDomain(["something entirely unrelated"]), "general");
});

test("KnowledgeBase.recall applies domain boost, per-module cap, and minScore floor", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-knowledge-"));
  const config = { ...loadConfig(rootDir), knowledgeDbPath: ":memory:" };
  const kb = new KnowledgeBase(config);
  t.after(() => kb.close());

  // Domain boost: identical content under two domains should tie on base score;
  // only the declared-domain boost (score * 1.5) should decide the winner.
  await kb.add({
    content: "Distribution channel launch playbook for growth teams entering a new market.",
    source: "seed/gtm-1", metadata: { domain: "gtm", moduleId: "boost-a", layer: "raw" },
  });
  await kb.add({
    content: "Distribution channel launch playbook for growth teams entering a new market.",
    source: "seed/sales-1", metadata: { domain: "sales", moduleId: "boost-b", layer: "raw" },
  });

  // Per-module cap: three entries sharing one moduleId, all relevant to the same query.
  for (let i = 0; i < 3; i += 1) {
    await kb.add({
      content: `Onboarding checklist step ${i + 1}: verify workspace access and welcome the new member.`,
      source: `seed/module-x-${i}`, metadata: { domain: "general", moduleId: "module-x", layer: "raw" },
    });
  }

  // A control entry, unrelated to the queries above.
  await kb.add({
    content: "Quarterly budget reconciliation notes for the finance team.",
    source: "seed/finance-1", metadata: { domain: "general", moduleId: "finance", layer: "raw" },
  });

  const boosted = await kb.recall("Distribution channel launch playbook for growth teams entering a new market.", { domain: "sales", k: 10 });
  assert.ok(boosted.length >= 1, "expected at least one boosted-domain hit");
  assert.equal((boosted[0].metadata as Record<string, unknown>).domain, "sales", "the domain-boosted entry should rank first on a score tie");

  const capped = await kb.recall("Onboarding checklist step: verify workspace access and welcome the new member.", { k: 10 });
  const moduleXHits = capped.filter((r) => (r.metadata as Record<string, unknown> | null)?.moduleId === "module-x");
  assert.ok(moduleXHits.length <= 2, `expected at most 2 hits per module, got ${moduleXHits.length}`);

  const permissive = await kb.recall("Distribution channel launch playbook for growth teams entering a new market.", { minScore: 0 });
  const strict = await kb.recall("Distribution channel launch playbook for growth teams entering a new market.", { minScore: 0.99 });
  assert.ok(permissive.length > 0, "expected hits with a permissive minScore");
  assert.equal(strict.length, 0, "an unreachable minScore floor should filter out every result");
});
