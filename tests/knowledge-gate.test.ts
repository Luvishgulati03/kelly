import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RecallResult } from "engram-memory";
import { loadConfig } from "../src/config.ts";
import type { ActivityLog } from "../src/activity.ts";
import { HenryAgent } from "../src/agent/henry.ts";
import type { HenryMemory } from "../src/memory/engram.ts";
import {
  disabledDomains, domainPolicy, retrieveGated, setDomainEnabled,
} from "../src/knowledge/gate.ts";
import { KNOWLEDGE_DOMAINS, KnowledgeBase } from "../src/knowledge/store.ts";
import { readSettings, updateSettings } from "../src/util/settings.ts";

/** One query every seeded entry answers, so each lane is genuinely retrievable. */
const QUERY = "launch planning steps and timeline";

function domainOf(result: RecallResult): unknown {
  return (result.metadata as Record<string, unknown> | null)?.domain;
}

async function seedKb(t: { after(fn: () => void): void }): Promise<{ kb: KnowledgeBase; rootDir: string; settingsPath: string }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-gate-"));
  const config = { ...loadConfig(rootDir), knowledgeDbPath: ":memory:" };
  const kb = new KnowledgeBase(config);
  t.after(() => kb.close());

  const seeds: Array<{ moduleId: string; metadata: Record<string, unknown>; text: string }> = [
    { moduleId: "community-1", metadata: { domain: "community" }, text: "Launch planning steps and timeline for a community cohort: pick the goal, list the steps, check the timeline." },
    { moduleId: "community-2", metadata: { domain: "community" }, text: "Planning a community meetup launch: steps, owners, and the timeline for each milestone week." },
    { moduleId: "gtm-1", metadata: { domain: "gtm" }, text: "Launch planning steps and timeline for a go-to-market motion: pick the channel, list the steps, check the timeline." },
    { moduleId: "gtm-2", metadata: { domain: "gtm" }, text: "Distribution launch planning: sequencing the steps and the timeline across paid and organic channels." },
    { moduleId: "pm-1", metadata: { domain: "project-management" }, text: "Launch planning steps and timeline for a project schedule: pick the critical path, list the steps, check the timeline." },
    { moduleId: "gen-1", metadata: { domain: "general" }, text: "Launch planning steps and timeline notes kept for general reference across the team." },
    { moduleId: "sales-1", metadata: { domain: "sales" }, text: "Launch planning steps and timeline for the outbound sales motion and its pipeline reviews." },
    // Corpus noise: a row tagged with a lane that is not a known domain, and a row with no
    // domain tag at all. Neither appears in any exclude list, so they exercise the paths that
    // have to cope with metadata the ingest side never promised.
    { moduleId: "rogue-1", metadata: { domain: "internal-secrets" }, text: "Launch planning steps and timeline for Luvish's confidential internal playbook." },
    { moduleId: "untagged-1", metadata: {}, text: "Launch planning steps and timeline written down without any domain tag at all." },
  ];
  for (const seed of seeds) {
    await kb.add({ content: seed.text, source: `seed/${seed.moduleId}`, metadata: { ...seed.metadata, moduleId: seed.moduleId, layer: "raw" } });
  }
  return { kb, rootDir, settingsPath: config.settingsPath };
}

test("retrieveGated: k is clamped, and a malformed toggle map is ignored rather than obeyed", async (t) => {
  const { kb, rootDir, settingsPath } = await seedKb(t);

  // Non-vacuity control: the lanes below ARE retrievable for this query, so the exclusions
  // that follow prove filtering rather than an empty corpus.
  const personal = await retrieveGated(kb, QUERY, { audience: "personal", k: 20, settingsPath });
  const personalDomains = personal.map(domainOf);
  assert.ok(personalDomains.includes("gtm"), "control: gtm is reachable for a personal audience");
  assert.ok(personalDomains.includes("project-management"), "control: project-management is reachable for a personal audience");

  // k is clamped to [1, 100] whatever the caller passes, on both audiences.
  for (const audience of ["personal", "admin"] as const) {
    for (const k of [0, -5, 1, 500, 1000]) {
      const results = await retrieveGated(kb, QUERY, { audience, k, settingsPath });
      assert.ok(results.length <= Math.max(1, Math.min(k, 100)), `k must bound results for ${audience}/${k}`);
    }
  }

  // A malformed toggle map is ignored rather than obeyed, and a missing file is not an error.
  const junkSettings = await writeSettings(rootDir, "junk.json", {
    knowledge: { domainToggles: { gtm: "yes" } },
  });
  const missingSettings = path.join(rootDir, "does-not-exist.json");
  for (const settings of [junkSettings, missingSettings]) {
    const results = await retrieveGated(kb, QUERY, { audience: "personal", domains: ["gtm"], k: 20, settingsPath: settings });
    assert.ok(results.some((r) => domainOf(r) === "gtm"), "a non-boolean toggle is not a kill switch");
  }
});

async function writeSettings(dir: string, name: string, value: Record<string, unknown>): Promise<string> {
  const target = path.join(dir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return target;
}

test("retrieveGated: a personal audience honors the settings domain toggles", async (t) => {
  const { kb, rootDir, settingsPath } = await seedKb(t);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify({ provider: "claude" }, null, 2)}\n`, "utf8");

  const before = await retrieveGated(kb, QUERY, { audience: "personal", k: 20, settingsPath });
  assert.ok(before.some((r) => domainOf(r) === "gtm"), "gtm is enabled by default (missing toggle = enabled)");

  setDomainEnabled(settingsPath, "gtm", false);
  assert.deepEqual(disabledDomains(settingsPath), ["gtm"]);
  const disabled = await retrieveGated(kb, QUERY, { audience: "personal", k: 20, settingsPath });
  assert.equal(disabled.filter((r) => domainOf(r) === "gtm").length, 0, "a disabled lane must return nothing for personal either");
  assert.ok(disabled.length > 0, "disabling one lane must not empty the whole corpus");

  // Not even by asking for it explicitly, and not for an admin either.
  const asked = await retrieveGated(kb, QUERY, { audience: "personal", domains: ["gtm"], k: 20, settingsPath });
  assert.equal(asked.filter((r) => domainOf(r) === "gtm").length, 0, "an explicit request cannot re-enable a disabled lane");
  const admin = await retrieveGated(kb, QUERY, { audience: "admin", domains: ["gtm"], k: 20, settingsPath });
  assert.equal(admin.filter((r) => domainOf(r) === "gtm").length, 0, "the toggle applies to the admin surface too");

  setDomainEnabled(settingsPath, "gtm", true);
  assert.deepEqual(disabledDomains(settingsPath), []);
  const after = await retrieveGated(kb, QUERY, { audience: "personal", k: 20, settingsPath });
  assert.ok(after.some((r) => domainOf(r) === "gtm"), "re-enabling brings the lane back");
  assert.equal(readSettings(settingsPath).provider, "claude", "the toggle round-trip kept the provider key");
  void rootDir;
});

test("setDomainEnabled persists through a read-merge-write and rejects unknown domains", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-gate-settings-"));
  const settingsPath = path.join(rootDir, "data", "settings.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  // The exact shape of the live file, plus a sibling key inside `knowledge`.
  await fs.writeFile(settingsPath, `${JSON.stringify({ provider: "claude", pmMode: true, knowledge: { note: "keep me" } }, null, 2)}\n`, "utf8");

  setDomainEnabled(settingsPath, "gtm", false);
  setDomainEnabled(settingsPath, "project-management", false);
  setDomainEnabled(settingsPath, "community", true);

  const persisted = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
  assert.equal(persisted.provider, "claude", "regression (runtime.ts:194 wipe bug): provider must survive a settings write");
  assert.equal(persisted.pmMode, true, "unrelated top-level keys must survive too");
  const knowledge = persisted.knowledge as Record<string, unknown>;
  assert.equal(knowledge.note, "keep me", "sibling knowledge.* keys survive the one-level merge");
  assert.deepEqual(knowledge.domainToggles, { gtm: false, "project-management": false, community: true }, "each toggle accumulates instead of replacing the map");

  assert.throws(() => setDomainEnabled(settingsPath, "gtmm", false), /Unknown knowledge domain/);
  assert.throws(() => setDomainEnabled(settingsPath, "__proto__", false), /Unknown knowledge domain/);
  const unchanged = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(unchanged, persisted, "a rejected domain must not touch the file");
});

test("domainPolicy reports every knowledge domain", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-gate-policy-"));
  const settingsPath = path.join(rootDir, "settings.json");

  const fresh = domainPolicy(settingsPath); // no settings file at all
  assert.equal(fresh.length, KNOWLEDGE_DOMAINS.length);
  assert.deepEqual(fresh.map((entry) => entry.domain), [...KNOWLEDGE_DOMAINS]);
  assert.ok(fresh.every((entry) => entry.enabled), "a missing toggle reads as enabled");

  setDomainEnabled(settingsPath, "gtm", false);
  const updated = domainPolicy(settingsPath);
  assert.equal(updated.find((entry) => entry.domain === "gtm")?.enabled, false);
  assert.equal(updated.find((entry) => entry.domain === "community")?.enabled, true, "one toggle never touches its siblings");
  assert.equal(updated.length, KNOWLEDGE_DOMAINS.length, "a toggle never adds or drops a row");
});

test("KnowledgeBase.recall excludeDomains hard-filters and still fills k from the other lanes", async (t) => {
  const { kb } = await seedKb(t);

  const wide = await kb.recall(QUERY, { k: 20 });
  assert.ok(wide.some((r) => domainOf(r) === "gtm"), "control: gtm is retrievable for this query");
  assert.equal((await kb.recall(QUERY, { k: 20, excludeDomains: ["gtm"] })).filter((r) => domainOf(r) === "gtm").length, 0, "excluded domain must be absent");

  // Exclude the entire unfiltered top-k: a filter that drops every winner must still return
  // k results, drawn from further down the ranking (the over-fetch), not a short page.
  const baseline = await kb.recall(QUERY, { k: 3 });
  assert.equal(baseline.length, 3);
  const topDomains = baseline.map((r) => String(domainOf(r)));
  const filtered = await kb.recall(QUERY, { k: 3, excludeDomains: topDomains });
  assert.equal(filtered.filter((r) => topDomains.includes(String(domainOf(r)))).length, 0, "excluded domains must be absent");
  assert.equal(filtered.length, 3, "over-fetch must backfill k from the remaining lanes");
  assert.equal(filtered.filter((r) => baseline.some((b) => b.id === r.id)).length, 0, "the survivors are different rows, not the filtered ones");

  const multi = await kb.recall(QUERY, { k: 8, excludeDomains: ["gtm", "project-management", "sales", "general"] });
  assert.equal(multi.filter((r) => ["gtm", "project-management", "sales", "general"].includes(String(domainOf(r)))).length, 0);
  assert.ok(multi.some((r) => domainOf(r) === "community"), "surviving lanes still rank");

  // Absent/empty option = zero behavior change.
  const untouched = await kb.recall(QUERY, { k: 3, excludeDomains: [] });
  assert.deepEqual(untouched.map((r) => r.id), baseline.map((r) => r.id));

  // context() forwards the same filter into the rendered block.
  const block = await kb.context(QUERY, { k: 8, excludeDomains: ["gtm", "project-management"] });
  assert.doesNotMatch(block, /\[gtm ·/);
  assert.doesNotMatch(block, /\[project-management ·/);
  assert.match(block, /\[community ·/);
});

test("henry buildPrompt passes the disabled lanes down and drops the pmMode force when project-management is off", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-gate-agent-"));
  const config = { ...loadConfig(rootDir), pmMode: true };
  const activity = { record: async () => {} } as unknown as ActivityLog;
  const memory = { context: async () => "" } as unknown as HenryMemory;
  const seen: Array<{ domain?: string; excludeDomains?: string[] }> = [];
  const fakeKb = { context: async (_q: string, o: { domain?: string; excludeDomains?: string[] }) => { seen.push(o); return ""; } } as unknown as KnowledgeBase;
  const agent = new HenryAgent(config, activity, memory, () => fakeKb);
  const neutral = "walk me through what you think about our situation this week and what we should do next";

  await agent.buildPrompt(neutral, "run-1");
  assert.equal(seen.length, 1, "a substantive turn probes the corpus");
  assert.equal(seen[0].domain, "project-management", "pmMode forces the PM lane while it is enabled");
  assert.deepEqual(seen[0].excludeDomains, []);

  setDomainEnabled(config.settingsPath, "project-management", false);
  setDomainEnabled(config.settingsPath, "sales", false);
  await agent.buildPrompt(neutral, "run-2");
  assert.equal(seen[1].domain, undefined, "a disabled project-management lane cancels the pmMode force");
  assert.deepEqual(seen[1].excludeDomains, ["project-management", "sales"], "settings toggles reach Henry's own retrieval");

  // A routed (regex-detected) domain that is switched off also falls through as null.
  await agent.buildPrompt("help me build the project schedule and critical path for the beta", "run-3");
  assert.equal(seen[2].domain, undefined, "a disabled routed domain is not passed as a boost");
  assert.ok(seen[2].excludeDomains?.includes("project-management"));
});

test("disabledDomains serves the cached answer until the settings mtime changes", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-gate-cache-"));
  const settingsPath = path.join(rootDir, "settings.json");

  // A missing file is cached too (stamped mtime 0) — the common "no settings yet" case.
  assert.deepEqual(disabledDomains(settingsPath), []);

  // Byte-identical lengths: only the toggle VALUES swap, so the file changes without its size doing so.
  const gtmOff = JSON.stringify({ knowledge: { domainToggles: { gtm: false, sales: true } } });
  const salesOff = JSON.stringify({ knowledge: { domainToggles: { gtm: true, sales: false } } });
  assert.equal(gtmOff.length, salesOff.length, "the staleness proof needs two same-size bodies");

  const pinned = new Date(1_700_000_000_000);
  writeFileSync(settingsPath, gtmOff, "utf8");
  utimesSync(settingsPath, pinned, pinned);
  assert.deepEqual(disabledDomains(settingsPath), ["gtm"], "the file appearing invalidates the mtime-0 entry");

  writeFileSync(settingsPath, salesOff, "utf8");
  utimesSync(settingsPath, pinned, pinned); // same mtime, same size: nothing the cache can observe
  assert.equal(statSync(settingsPath).mtimeMs, pinned.getTime(), "utimesSync pinned the mtime exactly");
  assert.deepEqual(disabledDomains(settingsPath), ["gtm"], "an unchanged stamp serves the cached answer (stale by design)");

  const bumped = new Date(pinned.getTime() + 5_000);
  utimesSync(settingsPath, bumped, bumped);
  assert.deepEqual(disabledDomains(settingsPath), ["sales"], "a bumped mtime re-reads the file");

  // The gate's own writer never waits on the clock — a kill switch applies to the next call.
  setDomainEnabled(settingsPath, "careers", false);
  assert.deepEqual(disabledDomains(settingsPath).sort(), ["careers", "sales"], "setDomainEnabled drops its own cache entry");

  const returned = disabledDomains(settingsPath);
  returned.push("community");
  assert.equal(disabledDomains(settingsPath).includes("community"), false, "a caller mutating the result cannot poison the cache");
});

test("settings helper: reads defensively and never wipes keys on write", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-gate-util-"));
  const missing = path.join(rootDir, "nope.json");
  assert.deepEqual(readSettings(missing), {});

  const corrupt = path.join(rootDir, "corrupt.json");
  await fs.writeFile(corrupt, "{ not json", "utf8");
  assert.deepEqual(readSettings(corrupt), {});
  const scalar = path.join(rootDir, "scalar.json");
  await fs.writeFile(scalar, `"claude"`, "utf8");
  assert.deepEqual(readSettings(scalar), {}, "a non-object settings file reads as empty");

  const settingsPath = path.join(rootDir, "nested", "settings.json");
  updateSettings(settingsPath, { provider: "claude", knowledge: { domainToggles: { gtm: false } } });
  assert.equal((statSync(settingsPath).mode & 0o777), 0o600, "settings are written 0600");
  const merged = updateSettings(settingsPath, { pmMode: true, knowledge: { other: 1 } });
  assert.deepEqual(merged, { provider: "claude", knowledge: { domainToggles: { gtm: false }, other: 1 }, pmMode: true });
  assert.deepEqual(readSettings(settingsPath), merged, "what was returned is what was persisted");
});
