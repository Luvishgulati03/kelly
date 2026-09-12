import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActivityLog } from "../src/activity.ts";
import { loadConfig } from "../src/config.ts";
import { AdmissionController } from "../src/orchestration/admission.ts";
import { ProviderRunner, buildProviderArgs, resolveProviderRoute, type ProviderRunnerDeps } from "../src/providers/runner.ts";
import type { ProviderEvent, ProviderName } from "../src/types.ts";

function modelArg(args: string[]): string | undefined {
  const index = args.indexOf("-m");
  return index >= 0 ? args[index + 1] : undefined;
}

async function mockedRunner(provider: ProviderName = "codex"): Promise<{
  runner: ProviderRunner;
  calls: Array<{ command: string; args: string[]; provider: ProviderName }>;
  activity: ActivityLog;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "henry-job-routing-"));
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const config = {
    ...loadConfig(root),
    rootDir: root,
    dataDir,
    activityPath: path.join(dataDir, "activity.jsonl"),
    settingsPath: path.join(dataDir, "settings.json"),
    provider,
  };
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  const calls: Array<{ command: string; args: string[]; provider: ProviderName }> = [];
  const deps: ProviderRunnerDeps = {
    execute: async (command, args, _cwd, executedProvider) => {
      calls.push({ command, args, provider: executedProvider });
      const events: ProviderEvent[] = [{
        timestamp: new Date().toISOString(),
        stream: "stdout",
        text: JSON.stringify({ text: "ok" }),
        parsed: { text: "ok" },
      }];
      return { runId: `${executedProvider}-run`, provider: executedProvider, response: "ok", exitCode: 0, durationMs: 1, events };
    },
  };
  const admission = new AdmissionController({ samplePressure: async () => "ok" as const });
  return { runner: new ProviderRunner(config, activity, admission, deps), calls, activity };
}

test("Codex job roles force their configured role models at low t1", async () => {
  const { runner, calls, activity } = await mockedRunner("codex");

  await runner.run("tailor", { role: "resume-tailor", tier: "t2", timeoutMs: 20_000 });
  await runner.run("review", { role: "application-review", timeoutMs: 20_000 });
  await runner.run("manage", { role: "application-manager", tier: "t0", timeoutMs: 20_000 });

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => modelArg(call.args)), ["gpt-5.5", "gpt-5.5", "gpt-5.6-sol"]);
  for (const call of calls) {
    assert.equal(call.command, "codex");
    assert.ok(call.args.includes('model_reasoning_effort="low"'));
    assert.ok(!call.args.includes('model_reasoning_effort="high"'));
    assert.ok(!call.args.includes('model_reasoning_effort="medium"'));
  }

  const started = (await activity.list(20)).filter((event) => event.kind === "run.started").reverse();
  assert.deepEqual(started.map((event) => event.metadata?.tier), ["t1", "t1", "t1"]);
  assert.deepEqual(started.map((event) => event.metadata?.model), ["gpt-5.5", "gpt-5.5", "gpt-5.6-sol"]);
  assert.deepEqual(started.map((event) => event.metadata?.role), ["resume-tailor", "application-review", "application-manager"]);
});

test("Codex job role defaults survive direct argv construction without config", () => {
  assert.equal(modelArg(buildProviderArgs("codex", "p", { readOnly: true, role: "resume-tailor" })), "gpt-5.5");
  assert.equal(modelArg(buildProviderArgs("codex", "p", { readOnly: true, role: "application-review" })), "gpt-5.5");
  assert.equal(modelArg(buildProviderArgs("codex", "p", { readOnly: true, role: "application-manager" })), "gpt-5.6-sol");
  assert.deepEqual(resolveProviderRoute("codex", { role: "application-review" }), {
    tier: "t1",
    model: "gpt-5.5",
    roleModelOverride: true,
  });
});

test("Claude is unaffected by Codex-only job role routing", async () => {
  const { runner, calls, activity } = await mockedRunner("claude");

  await runner.run("review", { provider: "claude", role: "application-review", tier: "t2", timeoutMs: 20_000 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "claude");
  assert.deepEqual(calls[0].args, ["-p", "--model", "opus", "review", "--dangerously-skip-permissions"]);
  const started = (await activity.list(10)).find((event) => event.kind === "run.started");
  assert.equal(started?.metadata?.tier, "t2");
  assert.equal(started?.metadata?.model, "opus");
  assert.equal(started?.metadata?.roleModelOverride, false);
});
