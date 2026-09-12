import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { LaunchCrewService } from "../src/launch/service.ts";
import { computeLaunchPhase, parseAnsweredQuestions, resolveLaunchSource, slugifyLaunch } from "../src/launch/format.ts";
import type { HenryMemory } from "../src/memory/engram.ts";
import type { KnowledgeBase } from "../src/knowledge/store.ts";
import type { ProviderRunner } from "../src/providers/runner.ts";
import type { RunResult } from "../src/types.ts";

const INTAKE_JSON = JSON.stringify({
  productSummary: "A WhatsApp-first community product for Indian college students learning AI skills.",
  questions: [
    { text: "What is the ICP?", citation: "gtm - community-led-growth" },
    { text: "What is the pricing model?", citation: "gtm - pricing-playbook" },
    { text: "What launch channels will be used?", citation: null },
    { text: "What is the target timeline?", citation: "gtm - launch-sequencing" },
  ],
});

const SYNTH_JSON = JSON.stringify({
  strategy: "STRATEGY_MARKER focus on WhatsApp community seeding.",
  auditStatus: "AUDIT_STATUS_MARKER",
  competitiveGaps: "GAPS_MARKER",
  roadmap: "ROADMAP_MARKER",
  openRisks: "RISKS_MARKER",
});

interface FakeCall { role: string; startedAt: number; finishedAt: number }

function fakeMemory(remembered: Array<{ content: string; importance?: number; metadata?: Record<string, unknown> }>): HenryMemory {
  return {
    remember: async (content: string, input?: { importance?: number; metadata?: Record<string, unknown> }) => {
      remembered.push({ content, importance: input?.importance, metadata: input?.metadata });
      return `mem-${remembered.length}`;
    },
  } as unknown as HenryMemory;
}

function fakeKnowledge(contextText = "[gtm - community-led-growth] Seed a founding cohort before paid channels."): () => KnowledgeBase {
  return () => ({ context: async () => contextText } as unknown as KnowledgeBase);
}

/** Role-keyed canned responses; records start/finish times so tests can assert real overlap, not just call order. */
function fakeRunner(responses: Record<string, string>, calls: FakeCall[], delays: Record<string, number> = {}): ProviderRunner {
  return {
    run: async (_prompt: string, options?: { role?: string }): Promise<RunResult> => {
      const role = options?.role || "unknown";
      const startedAt = Date.now();
      const delay = delays[role] ?? 0;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const finishedAt = Date.now();
      calls.push({ role, startedAt, finishedAt });
      const response = responses[role];
      if (response === undefined) throw new Error(`fakeRunner: no canned response for role "${role}"`);
      return { runId: `run-${role}`, provider: "codex", response, exitCode: 0, durationMs: finishedAt - startedAt, events: [] };
    },
  } as unknown as ProviderRunner;
}

function overlaps(a: FakeCall, b: FakeCall): boolean {
  return a.startedAt < b.finishedAt && b.startedAt < a.finishedAt;
}

/** Fills in the first `n` blank "ANSWER:" lines, mimicking Luvish hand-editing intake.md. */
function fillAnswers(markdown: string, n: number): string {
  let count = 0;
  return markdown.replace(/ANSWER:\s*$/gm, (match) => {
    count += 1;
    return count <= n ? `ANSWER: Answer number ${count}` : match;
  });
}

async function setup(): Promise<{ config: ReturnType<typeof loadConfig>; activity: ActivityLog }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-launch-"));
  const config = loadConfig(rootDir);
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  return { config, activity };
}

// --- pure format.ts logic ---

test("slugifyLaunch produces a filesystem-safe slug from prose or a path", () => {
  assert.equal(slugifyLaunch("A WhatsApp-first Community Product!"), "a-whatsapp-first-community-product");
  assert.equal(slugifyLaunch("/Users/dad/dev/my-app/"), "my-app");
});

test("resolveLaunchSource: a real directory resolves to repo, free-text prose resolves to brief", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-launch-src-"));
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-launch-repo-"));

  const repoSource = await resolveLaunchSource(repoDir, rootDir);
  assert.equal(repoSource.kind, "repo");
  assert.equal((repoSource as { kind: "repo"; path: string }).path, repoDir);

  const briefSource = await resolveLaunchSource("A WhatsApp-first community product for college students learning AI skills", rootDir);
  assert.equal(briefSource.kind, "brief");
});

test("computeLaunchPhase: pending -> ready -> complete", () => {
  assert.equal(computeLaunchPhase(1, false), "intake-pending-answers");
  assert.equal(computeLaunchPhase(3, false), "ready");
  assert.equal(computeLaunchPhase(0, true), "complete");
});

// --- service.intake() ---

test("intake() writes intake.md + intake.json with numbered questions, ANSWER blanks, and playbook citations", async () => {
  const { config, activity } = await setup();
  const calls: FakeCall[] = [];
  const service = new LaunchCrewService(config, activity, fakeMemory([]), fakeKnowledge(), fakeRunner({ "launch-intake": INTAKE_JSON }, calls));

  const result = await service.intake("A WhatsApp-first community product for Indian college students learning AI skills");

  assert.equal(result.record.questions.length, 4);
  assert.equal(result.record.sourceKind, "brief");
  assert.match(result.markdown, /## Questions for Luvish/);
  // Use the real parser, not a naive substring count -- the instructions line itself
  // says the word "ANSWER:" in prose, so only line-anchored blanks should count.
  assert.equal(parseAnsweredQuestions(result.markdown).length, 4);
  assert.match(result.markdown, /gtm - community-led-growth/);
  assert.match(result.markdown, /## Recalled playbooks/);

  const onDisk = await fs.readFile(result.filePath, "utf8");
  assert.equal(onDisk, result.markdown);
  const record = JSON.parse(await fs.readFile(result.recordPath, "utf8"));
  assert.equal(record.slug, result.slug);
  assert.equal(record.productSummary, result.record.productSummary);

  const events = await activity.list(20);
  assert.ok(events.some((e) => e.kind === "task.started"), "expected task.started");
  assert.ok(events.some((e) => e.kind === "task.completed"), "expected task.completed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].role, "launch-intake");
});

// --- service.run() validation ---

test("run() refuses when fewer than 3 questions are answered, and dispatches nothing", async () => {
  const { config, activity } = await setup();
  const calls: FakeCall[] = [];
  const service = new LaunchCrewService(config, activity, fakeMemory([]), fakeKnowledge(), fakeRunner({ "launch-intake": INTAKE_JSON }, calls));
  const intake = await service.intake("A WhatsApp-first community product for Indian college students learning AI skills");

  const onlyTwoAnswered = fillAnswers(intake.markdown, 2);
  await fs.writeFile(intake.filePath, onlyTwoAnswered, "utf8");

  await assert.rejects(() => service.run(intake.slug), /at least 3|refused/i);
  // Validation must fail BEFORE any crew dispatch — only the earlier intake call happened.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].role, "launch-intake");
});

// --- service.run() full parallel fan-out + dossier assembly (repo path -> auditor runs) ---

test("run() fans out gtm-strategist/product-auditor/competition-researcher in parallel, synthesizes after, and assembles the dossier from all three", async () => {
  const { config, activity } = await setup();
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-launch-repo-"));
  const remembered: Array<{ content: string; importance?: number; metadata?: Record<string, unknown> }> = [];
  const calls: FakeCall[] = [];
  const responses: Record<string, string> = {
    "launch-intake": INTAKE_JSON,
    "gtm-strategist": "GTM_RAW_MARKER: seed WhatsApp groups city by city.",
    "product-auditor": "AUDIT_RAW_MARKER: repo has a working CLI, no tests yet.",
    "competition-researcher": "COMPETITION_RAW_MARKER: no direct WhatsApp-first competitor found (not live-web-verified).",
    "launch-synthesizer": SYNTH_JSON,
  };
  const delays = { "gtm-strategist": 30, "product-auditor": 30, "competition-researcher": 30 };
  const service = new LaunchCrewService(config, activity, fakeMemory(remembered), fakeKnowledge(), fakeRunner(responses, calls, delays));

  const intake = await service.intake(repoDir);
  assert.equal(intake.record.sourceKind, "repo");
  const answered = fillAnswers(intake.markdown, 4);
  await fs.writeFile(intake.filePath, answered, "utf8");

  const run = await service.run(intake.slug);

  // Fan-out: all three specialists were dispatched and their windows overlap (genuine concurrency,
  // not just call order) -- Promise.all, not sequential awaits.
  const byRole = (role: string): FakeCall => calls.find((c) => c.role === role)!;
  const gtmCall = byRole("gtm-strategist");
  const auditCall = byRole("product-auditor");
  const competitionCall = byRole("competition-researcher");
  const synthCall = byRole("launch-synthesizer");
  assert.ok(gtmCall && auditCall && competitionCall && synthCall, "expected all four run-phase dispatches");
  assert.ok(overlaps(gtmCall, auditCall), "gtm-strategist and product-auditor should overlap");
  assert.ok(overlaps(gtmCall, competitionCall), "gtm-strategist and competition-researcher should overlap");
  assert.ok(overlaps(auditCall, competitionCall), "product-auditor and competition-researcher should overlap");
  // Synthesis only starts after all three finish.
  assert.ok(synthCall.startedAt >= gtmCall.finishedAt);
  assert.ok(synthCall.startedAt >= auditCall.finishedAt);
  assert.ok(synthCall.startedAt >= competitionCall.finishedAt);

  // Dossier assembled from all three raw outputs + the synthesizer's merged fields.
  assert.match(run.dossier, /GTM_RAW_MARKER/);
  assert.match(run.dossier, /AUDIT_RAW_MARKER/);
  assert.match(run.dossier, /COMPETITION_RAW_MARKER/);
  assert.match(run.dossier, /STRATEGY_MARKER/);
  assert.match(run.dossier, /ROADMAP_MARKER/);
  assert.match(run.dossier, /RISKS_MARKER/);
  const onDisk = await fs.readFile(run.filePath, "utf8");
  assert.equal(onDisk, run.dossier);

  // t0-free memory capture: exactly one direct remember() of the decision summary.
  assert.equal(remembered.length, 1);
  assert.match(remembered[0].content, /Launch dossier completed/);
  assert.equal(remembered[0].metadata?.domain, "launch");
  assert.equal(remembered[0].metadata?.slug, intake.slug);

  const events = await activity.list(30);
  assert.ok(events.some((e) => e.kind === "workflow.started"), "expected workflow.started");
  assert.ok(events.some((e) => e.kind === "workflow.completed"), "expected workflow.completed");
  assert.ok(events.filter((e) => e.kind === "agent.dispatched").length >= 4, "expected 4 agent.dispatched events");

  const listed = await service.list();
  const item = listed.find((i) => i.slug === intake.slug);
  assert.equal(item?.phase, "complete");
});

// --- service.run() brief-only skips the auditor ---

test("run() skips product-auditor gracefully when intake was brief-only (no repo path)", async () => {
  const { config, activity } = await setup();
  const calls: FakeCall[] = [];
  const responses: Record<string, string> = {
    "launch-intake": INTAKE_JSON,
    "gtm-strategist": "GTM_RAW_MARKER text.",
    "competition-researcher": "COMPETITION_RAW_MARKER text.",
    "launch-synthesizer": SYNTH_JSON,
  };
  const service = new LaunchCrewService(config, activity, fakeMemory([]), fakeKnowledge(), fakeRunner(responses, calls));

  const intake = await service.intake("A pure text product brief with no filesystem path anywhere in it");
  assert.equal(intake.record.sourceKind, "brief");
  await fs.writeFile(intake.filePath, fillAnswers(intake.markdown, 3), "utf8");

  const run = await service.run(intake.slug);

  assert.equal(calls.filter((c) => c.role === "product-auditor").length, 0, "product-auditor must never be dispatched for a brief-only launch");
  assert.match(run.dossier, /Skipped: intake was brief-only/);
});

// --- list() phase transitions ---

test("list() reports intake-pending-answers then ready before a dossier exists", async () => {
  const { config, activity } = await setup();
  const calls: FakeCall[] = [];
  const service = new LaunchCrewService(config, activity, fakeMemory([]), fakeKnowledge(), fakeRunner({ "launch-intake": INTAKE_JSON }, calls));

  const intake = await service.intake("A pure text product brief with no filesystem path anywhere in it, take two");
  let listed = await service.list();
  let item = listed.find((i) => i.slug === intake.slug);
  assert.equal(item?.phase, "intake-pending-answers");
  assert.equal(item?.questionsAnswered, 0);

  await fs.writeFile(intake.filePath, fillAnswers(intake.markdown, 3), "utf8");
  listed = await service.list();
  item = listed.find((i) => i.slug === intake.slug);
  assert.equal(item?.phase, "ready");
  assert.equal(item?.questionsAnswered, 3);
});

test("parseAnsweredQuestions ignores blank ANSWER lines and counts only filled ones", () => {
  const markdown = [
    "1. Question one",
    "   ANSWER: filled",
    "",
    "2. Question two",
    "   ANSWER:",
    "",
    "3. Question three",
    "   ANSWER:   ",
  ].join("\n");
  const answers = parseAnsweredQuestions(markdown);
  assert.equal(answers.length, 3);
  assert.equal(answers.filter((a) => a.answer.length > 0).length, 1);
});
