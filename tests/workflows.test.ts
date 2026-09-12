import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActivityLog } from "../src/activity.ts";
import { parseWorkflow, isAllowedDocsPath } from "../src/workflows/definition.ts";
import { WorkflowRegistry } from "../src/workflows/registry.ts";
import { WorkflowExecutor, RUNTIME_CONTEXT_HEADER } from "../src/workflows/executor.ts";
import { WorkflowSchedulerBridge } from "../src/workflows/scheduler-bridge.ts";
import type { HenryConfig } from "../src/config.ts";
import type { RunResult } from "../src/types.ts";
import type { RunOptions } from "../src/providers/runner.ts";
import type { WorkflowFile, WorkflowProviderRunner } from "../src/workflows/types.ts";

const VALID = `---
name: worklog
enabled: true
description: Daily operational update.
triggers:
  - type: schedule
    cron: "30 18 * * *"
    timezone: Asia/Kolkata
  - type: command
    command: worklog
outputs:
  - type: docs
    path: data/workflow-runs/worklog
runner:
  provider: codex
  tier: t1
  timeoutMs: 600000
concurrency: skip
---

Collect the last 24h of work and write a compact update.
`;

async function tempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function fakeRunner(
  respond: (prompt: string, options?: RunOptions) => Promise<Partial<RunResult>> | Partial<RunResult>,
): WorkflowProviderRunner & { prompts: string[]; options: Array<RunOptions | undefined> } {
  const prompts: string[] = [];
  const seen: Array<RunOptions | undefined> = [];
  return {
    prompts,
    options: seen,
    async run(prompt: string, options?: RunOptions): Promise<RunResult> {
      prompts.push(prompt);
      seen.push(options);
      const partial = await respond(prompt, options);
      return {
        runId: "fake-run", provider: "codex", response: "fake response",
        exitCode: 0, durationMs: 1, events: [], ...partial,
      };
    },
  };
}

async function harness(prefix: string): Promise<{ root: string; config: HenryConfig; activity: ActivityLog }> {
  const root = await tempDir(prefix);
  const config = { rootDir: root, dataDir: path.join(root, "data"), workflowsDir: path.join(root, "workflows") } as HenryConfig;
  const activity = new ActivityLog(path.join(config.dataDir, "activity.jsonl"));
  await activity.init();
  return { root, config, activity };
}

test("frontmatter parsing accepts a well-formed workflow", () => {
  const result = parseWorkflow(VALID, "/repo/workflows/worklog.workflow.md");
  assert.equal(result.ok, true, result.errors.join("; "));
  const workflow = result.workflow!;
  assert.equal(workflow.name, "worklog");
  assert.equal(workflow.enabled, true);
  assert.equal(workflow.description, "Daily operational update.");
  assert.deepEqual(workflow.triggers, [
    { type: "schedule", cron: "30 18 * * *", timezone: "Asia/Kolkata" },
    { type: "command", command: "worklog" },
  ]);
  assert.deepEqual(workflow.outputs, [{ type: "docs", path: "data/workflow-runs/worklog" }]);
  assert.deepEqual(workflow.runner, { provider: "codex", tier: "t1", timeoutMs: 600000 });
  assert.equal(workflow.concurrency, "skip");
  assert.match(workflow.body, /^Collect the last 24h/);
  assert.doesNotMatch(workflow.body, /---/);
});

test("the shipped worklog workflow parses", async () => {
  const filePath = path.resolve(import.meta.dirname, "../workflows/worklog.workflow.md");
  const result = parseWorkflow(await fs.readFile(filePath, "utf8"), filePath);
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.workflow?.name, "worklog");
  assert.ok(result.workflow?.triggers.some((trigger) => trigger.type === "schedule" && trigger.timezone === "Asia/Kolkata"));
  assert.ok(result.workflow?.triggers.some((trigger) => trigger.type === "command" && trigger.command === "worklog"));
});

test("frontmatter parsing rejects an unparseable cron", () => {
  const result = parseWorkflow(VALID.replace('"30 18 * * *"', '"not a cron"'), "/repo/workflows/worklog.workflow.md");
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("invalid cron")), result.errors.join("; "));
});

test("frontmatter parsing rejects a name that does not match the filename", () => {
  const result = parseWorkflow(VALID, "/repo/workflows/release-notes.workflow.md");
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("does not match filename")), result.errors.join("; "));
});

test("frontmatter parsing rejects docs paths that escape the run directory", () => {
  for (const bad of [
    "data/workflow-runs/worklog/../../../etc",
    "../../etc/passwd",
    "/etc/passwd",
    "data/workflow-runs/other",
    "data/other",
  ]) {
    const result = parseWorkflow(VALID.replace("data/workflow-runs/worklog", bad), "/repo/workflows/worklog.workflow.md");
    assert.equal(result.ok, false, `expected rejection for ${bad}`);
    assert.ok(result.errors.some((error) => error.includes("docs output path")), result.errors.join("; "));
  }
  assert.equal(isAllowedDocsPath("data/workflow-runs/worklog/nested", "worklog"), true);
  assert.equal(isAllowedDocsPath("data/workflow-runs/worklog", "worklog"), true);
});

test("frontmatter parsing rejects malformed documents", () => {
  assert.equal(parseWorkflow("no frontmatter here", "/repo/workflows/worklog.workflow.md").ok, false);
  assert.equal(parseWorkflow(VALID, "/repo/workflows/worklog.md").ok, false);
  const emptyBody = parseWorkflow(VALID.split("---")[0] + "---\n" + VALID.split("---")[1] + "---\n", "/repo/workflows/worklog.workflow.md");
  assert.equal(emptyBody.ok, false);
});

test("registry keeps the last known good workflow when a file becomes invalid", async () => {
  const { config, activity } = await harness("henry-workflow-registry-");
  await fs.mkdir(config.workflowsDir, { recursive: true });
  const filePath = path.join(config.workflowsDir, "worklog.workflow.md");
  await fs.writeFile(filePath, VALID, "utf8");

  const registry = new WorkflowRegistry(config.workflowsDir, activity);
  assert.equal((await registry.load()).length, 1);
  assert.equal(registry.get("worklog")?.description, "Daily operational update.");

  // Mid-edit save leaves an unparseable cron: the good version must stay armed.
  await fs.writeFile(filePath, VALID.replace('"30 18 * * *"', '"every so often"'), "utf8");
  const afterBadEdit = await registry.load();
  assert.equal(afterBadEdit.length, 1);
  assert.equal(registry.get("worklog")?.triggers.length, 2);
  assert.ok(registry.problems().worklog?.some((error) => error.includes("invalid cron")));

  // A valid rewrite clears the problem and takes effect.
  await fs.writeFile(filePath, VALID.replace("Daily operational update.", "Fixed description."), "utf8");
  await registry.load();
  assert.equal(registry.get("worklog")?.description, "Fixed description.");
  assert.deepEqual(registry.problems(), {});

  // Deleting the file drops the workflow entirely.
  await fs.rm(filePath);
  assert.deepEqual(await registry.load(), []);
  assert.equal(registry.get("worklog"), undefined);
  registry.stop();
});

test("executor injects runtime context, writes the artifact and records activity", async () => {
  const { config, activity } = await harness("henry-workflow-executor-");
  const workflow = parseWorkflow(VALID, "/repo/workflows/worklog.workflow.md").workflow as WorkflowFile;
  const runner = fakeRunner(() => ({ response: "## Shipped\n- the workflow engine" }));
  const executor = new WorkflowExecutor(config, activity, runner);

  const result = await executor.run(workflow, "test");
  assert.equal(result.status, "completed");
  assert.ok(result.artifactPath?.startsWith(path.join(config.rootDir, "data", "workflow-runs", "worklog")));

  const prompt = runner.prompts[0];
  assert.ok(prompt.startsWith(RUNTIME_CONTEXT_HEADER));
  const context = JSON.parse(prompt.slice(RUNTIME_CONTEXT_HEADER.length, prompt.indexOf("\n\n"))) as Record<string, any>;
  assert.equal(context.run.reason, "test");
  assert.equal(context.run.artifactPath, result.artifactPath);
  assert.equal(context.henry.rootDir, config.rootDir);
  assert.equal(context.workflow.name, "worklog");
  assert.ok(prompt.includes("Collect the last 24h of work"));
  assert.equal(runner.options[0]?.role, "workflow:worklog");
  assert.equal(runner.options[0]?.readOnly, false);
  assert.equal(runner.options[0]?.timeoutMs, 600000);
  assert.equal(runner.options[0]?.tier, "t1");

  const artifact = await fs.readFile(result.artifactPath!, "utf8");
  assert.match(artifact, /the workflow engine/);
  assert.equal(path.basename(result.artifactPath!), `${new Date().toISOString().slice(0, 10)}-${result.runId}.md`);
  assert.deepEqual(await executor.artifacts(workflow), [result.artifactPath]);

  const kinds = (await activity.list(50)).map((event) => event.kind);
  assert.ok(kinds.includes("workflow.started"));
  assert.ok(kinds.includes("workflow.completed"));
});

test("executor reports a failed run and still keeps the artifact", async () => {
  const { config, activity } = await harness("henry-workflow-failure-");
  const workflow = parseWorkflow(VALID, "/repo/workflows/worklog.workflow.md").workflow as WorkflowFile;
  const executor = new WorkflowExecutor(config, activity, fakeRunner(() => ({ response: "", exitCode: 1, error: "provider exploded" })));
  const result = await executor.run(workflow, "test");
  assert.equal(result.status, "failed");
  assert.equal(result.error, "provider exploded");
  assert.match(await fs.readFile(result.artifactPath!, "utf8"), /provider exploded/);
  assert.ok((await activity.list(50)).some((event) => event.kind === "workflow.failed"));
});

test("concurrency skip prevents a second overlapping run", async () => {
  const { config, activity } = await harness("henry-workflow-concurrency-");
  const workflow = parseWorkflow(VALID, "/repo/workflows/worklog.workflow.md").workflow as WorkflowFile;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runner = fakeRunner(async () => { await gate; return { response: "done" }; });
  const executor = new WorkflowExecutor(config, activity, runner);

  const first = executor.run(workflow, "schedule");
  const skipped = await executor.run(workflow, "cli");
  assert.equal(skipped.status, "skipped");
  release();
  assert.equal((await first).status, "completed");
  assert.equal(runner.prompts.length, 1);

  // Once the lock is released the workflow runs again.
  assert.equal((await executor.run(workflow, "cli")).status, "completed");
  assert.equal(runner.prompts.length, 2);
});

test("the scheduler bridge arms enabled schedule triggers and stops cleanly", async () => {
  const { config, activity } = await harness("henry-workflow-bridge-");
  await fs.mkdir(config.workflowsDir, { recursive: true });
  await fs.writeFile(path.join(config.workflowsDir, "worklog.workflow.md"), VALID, "utf8");
  await fs.writeFile(
    path.join(config.workflowsDir, "paused.workflow.md"),
    VALID.replace("name: worklog", "name: paused").replace("enabled: true", "enabled: false").replace(/worklog/g, "paused"),
    "utf8",
  );

  const registry = new WorkflowRegistry(config.workflowsDir, activity);
  await registry.load();
  const executor = new WorkflowExecutor(config, activity, fakeRunner(() => ({ response: "unused" })));
  const bridge = new WorkflowSchedulerBridge(registry, executor, activity);

  const armed = await bridge.start();
  assert.deepEqual(armed.map((job) => job.workflow), ["worklog"]);
  assert.equal(armed[0].cron, "30 18 * * *");
  assert.equal(armed[0].timezone, "Asia/Kolkata");
  assert.ok(armed[0].nextRun, "an armed job reports its next fire time");
  bridge.stop();
  assert.deepEqual(bridge.armed(), []);
  registry.stop();
});

test("concurrency parallel allows overlapping runs", async () => {
  const { config, activity } = await harness("henry-workflow-parallel-");
  const workflow = parseWorkflow(VALID.replace("concurrency: skip", "concurrency: parallel"), "/repo/workflows/worklog.workflow.md").workflow as WorkflowFile;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runner = fakeRunner(async () => { await gate; return { response: "done" }; });
  const executor = new WorkflowExecutor(config, activity, runner);
  const runs = [executor.run(workflow, "a"), executor.run(workflow, "b")];
  release();
  const results = await Promise.all(runs);
  assert.deepEqual(results.map((result) => result.status), ["completed", "completed"]);
});
