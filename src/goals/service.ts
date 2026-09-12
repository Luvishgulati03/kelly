import fs from "node:fs/promises";
import path from "node:path";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { HenryMemory } from "../memory/engram.ts";
import type { LunaOrchestrator } from "../orchestration/luna.ts";
import type { DispatchTier } from "../types.ts";

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "goal";
}

export interface GoalTask {
  description: string;
  tier: DispatchTier;
}

export interface GoalPlan {
  goal: string;
  tasks: GoalTask[];
  questions: string[];
}

const VALID_TIERS: DispatchTier[] = ["t0", "t1", "t2"];

/**
 * Parses the model's plan response. Tolerant of formatting drift — falls back to sane
 * defaults (the original description as the goal, "t1" for unrecognized tiers) rather
 * than throwing, since the raw response is always persisted alongside the parsed plan.
 */
export function parseGoalPlan(response: string, fallbackGoal: string): GoalPlan {
  const goalMatch = response.match(/^GOAL:\s*(.+)$/im);
  const goal = goalMatch?.[1]?.trim() || fallbackGoal;

  const tasks: GoalTask[] = [];
  const taskLine = /^-\s*\[ ?\]\s*(.+?)\s*\(tier:\s*(\S+?)\)\s*$/gim;
  for (const match of response.matchAll(taskLine)) {
    const description = match[1].trim();
    const rawTier = match[2].toLowerCase() as DispatchTier;
    const tier = VALID_TIERS.includes(rawTier) ? rawTier : "t1";
    if (description) tasks.push({ description, tier });
  }

  const questions: string[] = [];
  const questionsSection = response.split(/^##\s*Open questions.*$/im)[1];
  if (questionsSection) {
    for (const line of questionsSection.split("\n")) {
      const match = line.match(/^-\s*(.+)$/);
      if (!match) continue;
      const text = match[1].trim();
      if (text && !/^none$/i.test(text)) questions.push(text);
    }
  }

  return { goal, tasks, questions };
}

function renderGoalFile(description: string, plan: GoalPlan, createdAt: string): string {
  const tasks = plan.tasks.length
    ? plan.tasks.map((task) => `- [ ] ${task.description} (${task.tier})`).join("\n")
    : "- [ ] (no tasks parsed — see the raw plan in the activity log)";
  const questions = plan.questions.length ? plan.questions.map((question) => `- ${question}`).join("\n") : "- none";
  return [
    `# Goal: ${plan.goal}`,
    "",
    `_Original ask: ${description}_`,
    `_Created: ${createdAt}_`,
    "",
    "## Tasks",
    "",
    tasks,
    "",
    "## Open questions for Luvish",
    "",
    questions,
    "",
  ].join("\n");
}

export interface GoalIntakeResult {
  filePath: string;
  plan: GoalPlan;
  raw: string;
}

/**
 * Goal intake (MASTER_PLAN §11 doctrine): one t1 dispatch restates a goal, decomposes it
 * into 3-8 tier-tagged tasks, and surfaces open questions. Henry never auto-executes the
 * plan — Luvish reviews it, then runs `henry code`/`henry dispatch` or asks Henry to proceed.
 */
export class GoalService {
  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    private readonly memory: HenryMemory,
    private readonly luna: LunaOrchestrator,
  ) {}

  async intake(description: string): Promise<GoalIntakeResult> {
    const trimmed = description.trim();
    if (!trimmed) throw new Error("Usage: henry goal <description...>");

    const task = [
      "Luvish gave you a goal. Respond in this exact markdown format and nothing else — no preamble, no closing remarks.",
      "1. Restate the goal crisply on one line starting with 'GOAL:'.",
      "2. Under a '## Tasks' heading, decompose it into 3-8 concrete tasks. Each task is a markdown checkbox line: '- [ ] <task> (tier: t0|t1|t2)', tagged with the suggested executor tier per MASTER_PLAN.md §11 doctrine — t0 for triage/formatting/summaries, t1 for routine implementation, t2 for architecture or hard judgment calls.",
      "3. Under a '## Open questions' heading, list open questions for Luvish, each as '- <question>'. If there are none, write '- none'.",
      "Do not execute any task yourself. Do not invent facts about Luvish's situation — if you need information to decompose well, surface it as an open question instead of guessing.",
      `\nGoal from Luvish: ${trimmed}`,
    ].join("\n");

    const result = await this.luna.dispatch("architect", task, { tier: "t1" });
    if (result.exitCode !== 0 || !result.response.trim()) throw new Error(result.error || "Goal intake failed");
    const raw = result.response.trim();
    const plan = parseGoalPlan(raw, trimmed);

    await fs.mkdir(this.config.goalsDir, { recursive: true, mode: 0o700 });
    const createdAt = new Date().toISOString();
    const base = `${createdAt.slice(0, 10)}-${slugify(trimmed)}`;
    const filePath = path.join(this.config.goalsDir, `${base}.md`);
    await fs.writeFile(filePath, renderGoalFile(trimmed, plan, createdAt), "utf8");

    await this.activity.record(
      "task.started",
      `Goal intake: ${trimmed.slice(0, 120)}`,
      { filePath, taskCount: plan.tasks.length, questionCount: plan.questions.length },
    );
    await this.memory.remember(
      `Goal intake: ${plan.goal}. ${plan.tasks.length} tasks planned, ${plan.questions.length} open questions. File: ${filePath}`,
      { tier: "episodic", importance: 6, metadata: { domain: "goals", kind: "goal-intake" } },
    ).catch(() => "");

    return { filePath, plan, raw };
  }
}
