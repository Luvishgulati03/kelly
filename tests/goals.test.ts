import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { GoalService, parseGoalPlan } from "../src/goals/service.ts";
import type { HenryMemory } from "../src/memory/engram.ts";
import type { LunaOrchestrator } from "../src/orchestration/luna.ts";
import type { RunResult } from "../src/types.ts";

const PLAN_RESPONSE = [
  "GOAL: Ship a v1 reminders feature so Luvish never misses a follow-up.",
  "",
  "## Tasks",
  "- [ ] Design the reminders data model (tier: t1)",
  "- [ ] Implement the reminders CLI commands (tier: t1)",
  "- [ ] Wire the scheduler daemon to fire due reminders (tier: t1)",
  "- [ ] Decide the notification channel strategy (tier: t2)",
  "- [ ] Write a changelog entry (tier: t0)",
  "",
  "## Open questions",
  "- Should reminders support recurring schedules in v1?",
  "- Does Luvish want SMS delivery eventually?",
].join("\n");

function fakeMemory(remembered: Array<{ content: string }>): HenryMemory {
  return {
    remember: async (content: string) => {
      remembered.push({ content });
      return "mem-id";
    },
  } as unknown as HenryMemory;
}

function fakeLuna(response = PLAN_RESPONSE, exitCode = 0): { luna: LunaOrchestrator; calls: Array<{ role: string; task: string; options: unknown }> } {
  const calls: Array<{ role: string; task: string; options: unknown }> = [];
  const luna = {
    dispatch: async (role: string, task: string, options: unknown): Promise<RunResult> => {
      calls.push({ role, task, options });
      return { runId: "run-1", provider: "codex", response, exitCode, durationMs: 1, events: [] };
    },
  } as unknown as LunaOrchestrator;
  return { luna, calls };
}

async function setup(): Promise<{ config: ReturnType<typeof loadConfig>; activity: ActivityLog }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-goals-"));
  const config = loadConfig(rootDir);
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  return { config, activity };
}

test("parseGoalPlan extracts restated goal, tiered tasks, and open questions", () => {
  const plan = parseGoalPlan(PLAN_RESPONSE, "fallback goal");
  assert.equal(plan.goal, "Ship a v1 reminders feature so Luvish never misses a follow-up.");
  assert.equal(plan.tasks.length, 5);
  assert.deepEqual(plan.tasks[0], { description: "Design the reminders data model", tier: "t1" });
  assert.deepEqual(plan.tasks[3], { description: "Decide the notification channel strategy", tier: "t2" });
  assert.deepEqual(plan.tasks[4], { description: "Write a changelog entry", tier: "t0" });
  assert.deepEqual(plan.questions, [
    "Should reminders support recurring schedules in v1?",
    "Does Luvish want SMS delivery eventually?",
  ]);
});

test("parseGoalPlan falls back gracefully on malformed output", () => {
  const plan = parseGoalPlan("Some unstructured prose with no checkboxes.", "fallback goal");
  assert.equal(plan.goal, "fallback goal");
  assert.deepEqual(plan.tasks, []);
  assert.deepEqual(plan.questions, []);
});

test("parseGoalPlan treats '- none' under Open questions as no questions", () => {
  const response = "GOAL: X\n\n## Tasks\n- [ ] do a thing (tier: t1)\n\n## Open questions\n- none";
  const plan = parseGoalPlan(response, "fallback");
  assert.deepEqual(plan.questions, []);
});

test("parseGoalPlan defaults an unrecognized tier to t1", () => {
  const response = "GOAL: X\n\n## Tasks\n- [ ] do a thing (tier: t9)\n\n## Open questions\n- none";
  const plan = parseGoalPlan(response, "fallback");
  assert.equal(plan.tasks[0].tier, "t1");
});

test("intake() dispatches one t1 call, persists the plan file, records activity, and remembers a summary", async () => {
  const { config, activity } = await setup();
  const remembered: Array<{ content: string }> = [];
  const { luna, calls } = fakeLuna();
  const service = new GoalService(config, activity, fakeMemory(remembered), luna);

  const result = await service.intake("Ship a v1 reminders feature so Luvish never misses a follow-up.");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].role, "architect");
  assert.deepEqual(calls[0].options, { tier: "t1" });
  assert.match(calls[0].task, /Ship a v1 reminders feature/);

  assert.match(result.filePath, /data\/goals\/\d{4}-\d{2}-\d{2}-ship-a-v1-reminders-feature/);
  await fs.access(result.filePath);
  const written = await fs.readFile(result.filePath, "utf8");
  assert.match(written, /^# Goal: Ship a v1 reminders feature/);
  assert.match(written, /- \[ \] Design the reminders data model \(t1\)/);
  assert.match(written, /## Open questions for Luvish/);
  assert.match(written, /Should reminders support recurring schedules in v1\?/);

  assert.equal(result.plan.tasks.length, 5);
  assert.equal(remembered.length, 1);
  assert.match(remembered[0].content, /Goal intake: Ship a v1 reminders feature/);

  const events = await activity.list(10);
  assert.ok(events.some((event) => event.kind === "task.started" && /Goal intake/.test(event.message)));
});

test("intake() throws when the goal plan dispatch fails", async () => {
  const { config, activity } = await setup();
  const { luna } = fakeLuna("", 1);
  const service = new GoalService(config, activity, fakeMemory([]), luna);
  await assert.rejects(() => service.intake("Some goal"), /Goal intake failed/);
});

test("intake() rejects an empty description", async () => {
  const { config, activity } = await setup();
  const { luna } = fakeLuna();
  const service = new GoalService(config, activity, fakeMemory([]), luna);
  await assert.rejects(() => service.intake("   "), /Usage: henry goal/);
});
