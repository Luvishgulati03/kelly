import fs from "node:fs/promises";
import path from "node:path";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { HenryMemory } from "../memory/engram.ts";
import type { KnowledgeBase } from "../knowledge/store.ts";
import type { ProviderRunner } from "../providers/runner.ts";
import type { RunResult } from "../types.ts";
import {
  MIN_ANSWERED_QUESTIONS, computeLaunchPhase, parseAnsweredQuestions, parseIntakeResponse,
  parseSynthesisResponse, renderDossierMarkdown, renderIntakeMarkdown, resolveLaunchSource, slugifyLaunch,
} from "./format.ts";
import type { LaunchIntakeRecord, LaunchIntakeResult, LaunchListItem, LaunchRunResult } from "./types.ts";

interface CrewFinding {
  text: string;
  /** True only for the deterministic brief-only audit skip — never set for a dispatch failure. */
  skipped: boolean;
}

function fromResult(result: RunResult): CrewFinding {
  if (result.exitCode === 0 && result.response.trim()) return { text: result.response.trim(), skipped: false };
  return { text: `[failed: ${result.error || "no response from provider"}]`, skipped: false };
}

/**
 * LaunchCrewService — MASTER_PLAN.md §6.3, the digital-twin launch workflow.
 * Two Luvish-in-the-loop phases:
 *   intake(slugFromInput) — ONE t1 dispatch reads the product and derives the question
 *     list from what the recalled playbooks actually require.
 *   run(slug) — after Luvish fills in ANSWER: blanks, fans out gtm-strategist (t2),
 *     product-auditor (t1, skipped gracefully when brief-only) and competition-researcher
 *     (t1) in parallel through the shared admission-controlled runner, then one t2
 *     synthesizer merges everything into a dossier. No auto-fixing, no outbound anything.
 */
export class LaunchCrewService {
  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    private readonly memory: HenryMemory,
    // Lazy accessor (HenryAgent's pattern) so constructing this service never forces
    // the knowledge DB open — only an actual intake/run does.
    private readonly knowledgeProvider: () => KnowledgeBase,
    private readonly runner: ProviderRunner,
  ) {}

  private dir(slug: string): string { return path.join(this.config.dataDir, "launches", slug); }

  async intake(input: string): Promise<LaunchIntakeResult> {
    const trimmed = input.trim();
    if (!trimmed) throw new Error('Usage: henry launch intake "<product brief or repo path>"');
    await this.activity.record("task.started", `Launch intake: ${trimmed.slice(0, 120)}`, { input: trimmed.slice(0, 240) });

    const source = await resolveLaunchSource(trimmed, this.config.rootDir);
    const slug = slugifyLaunch(source.kind === "repo" ? path.basename(source.path) : trimmed);
    const knowledgeContext = await this.knowledgeProvider().context(trimmed, { domain: "gtm", budgetChars: 5000 }).catch(() => "");

    const productBlock = source.kind === "repo"
      ? `You have read-only access to a repository at ${source.path}. Inspect its structure, README, package manifest, and key source files before writing questions.`
      : `You do not have a repository to inspect. Reason from this product brief:\n\n${trimmed}`;

    const prompt = [
      "You are Henry's launch-intake specialist (MASTER_PLAN.md section 6.3, phase 1 of the launch crew).",
      "Derive the exact list of datapoints Luvish must answer before a GTM strategist can build a launch roadmap.",
      "Base the question list on what the recalled playbooks below actually require (things like ICP, pricing, channels, timeline, community size) -- do not pad with generic questions the playbooks don't call for, and never invent facts about the product.",
      "If the product itself is unclear from what you can inspect, that uncertainty becomes a question too.",
      "Return ONLY JSON, no markdown fences, no prose, matching exactly:",
      '{"productSummary": string, "questions": [{"text": string, "citation": string|null}]}',
      "productSummary: 2-4 sentences on what the product is/does.",
      "questions: 4 to 10 items. citation names the recalled playbook that motivated the question, formatted \"[domain - module]\", or null if it's a basic datapoint no specific card covers.",
      "",
      "--- product ---",
      productBlock,
      "",
      "--- recalled playbooks (tried & tested; may be empty) ---",
      knowledgeContext || "No relevant playbooks recalled.",
    ].join("\n");

    const result = await this.runner.run(prompt, {
      cwd: source.kind === "repo" ? source.path : this.config.rootDir,
      role: "launch-intake", tier: "t1", readOnly: true,
    });
    if (result.exitCode !== 0 || !result.response.trim()) throw new Error(result.error || "Launch intake failed");
    const { productSummary, questions } = parseIntakeResponse(result.response);
    const citations = [...new Set(questions.map((q) => q.citation).filter((c): c is string => Boolean(c)))];

    const record: LaunchIntakeRecord = {
      slug, createdAt: new Date().toISOString(), sourceKind: source.kind,
      ...(source.kind === "repo" ? { sourcePath: source.path } : {}),
      input: trimmed, productSummary, questions, citations,
    };

    const dir = this.dir(slug);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const markdown = renderIntakeMarkdown(record);
    const filePath = path.join(dir, "intake.md");
    const recordPath = path.join(dir, "intake.json");
    await fs.writeFile(filePath, markdown, "utf8");
    await fs.writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    await this.activity.record(
      "task.completed",
      `Launch intake ready: ${slug}`,
      { slug, filePath, questions: questions.length, citations: citations.length },
      { runId: result.runId, role: "launch-intake", provider: result.provider },
    );

    return { slug, filePath, recordPath, markdown, record };
  }

  async run(slug: string): Promise<LaunchRunResult> {
    const dir = this.dir(slug);
    const intakeMd = await fs.readFile(path.join(dir, "intake.md"), "utf8")
      .catch(() => { throw new Error(`No intake found for "${slug}" -- run: henry launch intake "<brief or path>"`); });
    const recordRaw = await fs.readFile(path.join(dir, "intake.json"), "utf8")
      .catch(() => { throw new Error(`Launch intake record missing for "${slug}" (intake.json) -- re-run henry launch intake.`); });
    const record = JSON.parse(recordRaw) as LaunchIntakeRecord;
    const answers = parseAnsweredQuestions(intakeMd).filter((a) => a.answer.length > 0);
    if (answers.length < MIN_ANSWERED_QUESTIONS) {
      throw new Error(
        `Launch run refused: only ${answers.length}/${record.questions.length} questions answered in ${path.join(dir, "intake.md")} -- fill at least ${MIN_ANSWERED_QUESTIONS} ANSWER: blanks first.`,
      );
    }

    await this.activity.record("workflow.started", `Launch run: ${slug}`, { slug, answered: answers.length });
    const qaBlock = answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n");

    const gtmPromise = (async (): Promise<CrewFinding> => {
      const knowledgeContext = await this.knowledgeProvider()
        .context(`${record.input}\n\n${qaBlock}`, { domain: "gtm", budgetChars: 5000 })
        .catch(() => "");
      const prompt = [
        "You are Henry's gtm-strategist (MASTER_PLAN.md section 6.3, phase 2 of the launch crew).",
        "Produce a launch roadmap and GTM strategy grounded in the recalled playbooks below. Explicitly cite which playbook module informed each major recommendation.",
        "Never invent facts about the product beyond what's given.",
        "", "--- product ---", record.productSummary,
        "", "--- Luvish's answers ---", qaBlock,
        "", "--- recalled playbooks ---", knowledgeContext || "No relevant playbooks recalled.",
      ].join("\n");
      const result = await this.runner.run(prompt, { role: "gtm-strategist", tier: "t2", readOnly: true, cwd: this.config.rootDir });
      await this.recordDispatch(result, "gtm-strategist");
      return fromResult(result);
    })();

    const auditPromise = (async (): Promise<CrewFinding> => {
      if (record.sourceKind !== "repo" || !record.sourcePath) {
        return { text: "Skipped: intake was brief-only (no repository path given), so no code audit was run.", skipped: true };
      }
      const prompt = [
        "You are Henry's product-auditor (MASTER_PLAN.md section 6.3, phase 2 of the launch crew).",
        `Investigate the repository at ${record.sourcePath} read-only and produce a code audit summary: structure, stack, notable risks/breaks, and launch-readiness. Do not edit anything.`,
      ].join("\n");
      const result = await this.runner.run(prompt, { role: "product-auditor", tier: "t1", readOnly: true, cwd: record.sourcePath });
      await this.recordDispatch(result, "product-auditor");
      return fromResult(result);
    })();

    const competitionPromise = (async (): Promise<CrewFinding> => {
      const prompt = [
        "You are Henry's competition-researcher (MASTER_PLAN.md section 6.3, phase 2 of the launch crew).",
        "Produce a competitor landscape and feature/positioning gap analysis for the product below.",
        "IMPORTANT: this dispatch has no live web-search flag wired up (Codex --search is not currently passed by Henry's ProviderRunner). Reason from your trained knowledge, and explicitly and honestly flag in your output that this is not live-web-verified research.",
        "", "--- product ---", record.productSummary,
        "", "--- Luvish's answers ---", qaBlock,
      ].join("\n");
      const result = await this.runner.run(prompt, { role: "competition-researcher", tier: "t1", readOnly: true, cwd: this.config.rootDir });
      await this.recordDispatch(result, "competition-researcher");
      return fromResult(result);
    })();

    // Promise.all: the three specialists run in parallel from our side; the shared
    // admission controller (MASTER_PLAN §7) serializes actual provider spawns.
    const [gtm, audit, competition] = await Promise.all([gtmPromise, auditPromise, competitionPromise]);

    const synthesisPrompt = [
      "You are Henry's launch-dossier synthesizer (MASTER_PLAN.md section 6.3, final phase of the launch crew).",
      "Merge the three specialist outputs below into one launch dossier. Return ONLY JSON, no markdown fences, no prose, matching exactly:",
      '{"strategy": string, "auditStatus": string, "competitiveGaps": string, "roadmap": string, "openRisks": string}',
      "openRisks must include any specialist failures/skips noted below, plus real product risks.",
      "", "--- gtm-strategist output ---", gtm.text,
      "", "--- product-auditor output ---", audit.text,
      "", "--- competition-researcher output ---", competition.text,
    ].join("\n");
    const synthResult = await this.runner.run(synthesisPrompt, { role: "launch-synthesizer", tier: "t2", readOnly: true, cwd: this.config.rootDir });
    await this.recordDispatch(synthResult, "launch-synthesizer");
    if (synthResult.exitCode !== 0 || !synthResult.response.trim()) throw new Error(synthResult.error || "Launch synthesis failed");
    const synthesis = parseSynthesisResponse(synthResult.response);

    const dossier = renderDossierMarkdown(record, synthesis, { gtm: gtm.text, audit: audit.text, competition: competition.text });
    const filePath = path.join(dir, "dossier.md");
    await fs.writeFile(filePath, dossier, "utf8");

    const summary = [
      `Launch dossier completed for "${slug}".`,
      `Strategy: ${synthesis.strategy.slice(0, 400)}`,
      `Audit: ${audit.skipped ? "skipped (brief-only)" : synthesis.auditStatus.slice(0, 200)}`,
      `Top risks: ${synthesis.openRisks.slice(0, 300)}`,
    ].join(" ");
    // t0-free memory capture (MASTER_PLAN §11.2.10): the synthesis call already did the
    // reasoning, so this is a direct write, not another dispatch.
    await this.memory.remember(summary, { tier: "episodic", importance: 7, metadata: { domain: "launch", slug, kind: "launch-dossier" } }).catch(() => "");

    await this.activity.record("workflow.completed", `Launch dossier complete: ${slug}`, { slug, filePath, auditSkipped: audit.skipped });

    return { slug, filePath, summary, dossier };
  }

  private async recordDispatch(result: RunResult, role: string): Promise<void> {
    await this.activity.record(
      "agent.dispatched",
      `Launch crew dispatched ${role}`,
      { role, success: result.exitCode === 0 },
      { runId: result.runId, role, provider: result.provider },
    );
  }

  async list(): Promise<LaunchListItem[]> {
    const root = path.join(this.config.dataDir, "launches");
    let names: string[] = [];
    try {
      names = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch { return []; }

    const items: LaunchListItem[] = [];
    for (const slug of names) {
      const base = path.join(root, slug);
      const intakeMd = await fs.readFile(path.join(base, "intake.md"), "utf8").catch(() => null);
      if (intakeMd === null) continue;
      const dossierExists = await fs.access(path.join(base, "dossier.md")).then(() => true).catch(() => false);
      const answers = parseAnsweredQuestions(intakeMd);
      const answered = answers.filter((a) => a.answer.length > 0).length;
      let createdAt: string | undefined;
      try { createdAt = (JSON.parse(await fs.readFile(path.join(base, "intake.json"), "utf8")) as LaunchIntakeRecord).createdAt; } catch { /* record missing; leave undefined */ }
      items.push({ slug, phase: computeLaunchPhase(answered, dossierExists), createdAt, questionsTotal: answers.length, questionsAnswered: answered });
    }
    return items;
  }
}
