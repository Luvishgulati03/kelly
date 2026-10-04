import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setActiveProfile } from "../src/profile.ts";
import { loadConfig, parseClaudeEffort, parseFailover, parseMaxConcurrentRuns } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { ProviderRunner } from "../src/providers/runner.ts";
import { AdmissionController } from "../src/orchestration/admission.ts";
import { HenryRuntime } from "../src/runtime.ts";
import type { ProviderName, RunResult } from "../src/types.ts";
import { tempDir } from "./tmp-dirs.ts";

/**
 * KELLY'S PROVIDER POLICY.
 *
 * Claude Code is Kelly's primary brain: t1 sonnet, t0 haiku, t2 opus, effort low/low/high, at
 * most two concurrent runs. Codex stays available two ways, both explicit owner choices: as the
 * primary (`kelly provider codex`, or KELLY_PROVIDER=codex), or as failover
 * (KELLY_FAILOVER=codex). Failover is OFF by default.
 */

const POLICY_KEYS = [
  "KELLY_PROVIDER", "KELLY_FAILOVER", "KELLY_MAX_CONCURRENT_RUNS",
  "KELLY_CLAUDE_MODEL", "KELLY_CLAUDE_T0_MODEL", "KELLY_CLAUDE_T2_MODEL",
  "KELLY_CLAUDE_EFFORT", "KELLY_CLAUDE_T0_EFFORT", "KELLY_CLAUDE_T2_EFFORT",
  "HENRY_PROVIDER", "HENRY_CLAUDE_MODEL", "HENRY_CLAUDE_EFFORT", "HENRY_FAILOVER",
];

function withEnv(t: { after(fn: () => void): void }, values: Record<string, string | undefined>): void {
  const saved = Object.fromEntries(POLICY_KEYS.map((key) => [key, process.env[key]]));
  for (const key of POLICY_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value;
  t.after(() => {
    for (const key of POLICY_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

test("Kelly defaults to Claude: sonnet/haiku/opus, effort low/low/high, failover off, two runs", (t) => {
  setActiveProfile("kelly");
  withEnv(t, {});
  const config = loadConfig(tempDir("kelly-policy-", t));
  assert.equal(config.provider, "claude");
  assert.equal(config.claudeModel, "sonnet");
  assert.equal(config.claudeT0Model, "haiku");
  assert.equal(config.claudeT2Model, "opus");
  assert.equal(config.claudeEffort, "low");
  assert.equal(config.claudeT0Effort, "low");
  assert.equal(config.claudeT2Effort, "high");
  assert.equal(config.failover, "off");
  assert.equal(config.maxConcurrentRuns, 2);
});

test("Kelly's provider, models, efforts, failover and concurrency are configurable", (t) => {
  setActiveProfile("kelly");
  withEnv(t, {
    KELLY_PROVIDER: "codex", KELLY_FAILOVER: "codex", KELLY_MAX_CONCURRENT_RUNS: "3",
    KELLY_CLAUDE_MODEL: "opus", KELLY_CLAUDE_T0_MODEL: "sonnet", KELLY_CLAUDE_T2_MODEL: "opus[1m]",
    KELLY_CLAUDE_EFFORT: "medium", KELLY_CLAUDE_T0_EFFORT: "HIGH", KELLY_CLAUDE_T2_EFFORT: "max",
  });
  const config = loadConfig(tempDir("kelly-policy-", t));
  assert.equal(config.provider, "codex");
  assert.equal(config.failover, "codex");
  assert.equal(config.maxConcurrentRuns, 3);
  assert.deepEqual([config.claudeModel, config.claudeT0Model, config.claudeT2Model], ["opus", "sonnet", "opus[1m]"]);
  assert.deepEqual([config.claudeEffort, config.claudeT0Effort, config.claudeT2Effort], ["medium", "high", "max"]);
});

test("invalid policy values fall back to the safe defaults", () => {
  assert.equal(parseClaudeEffort("turbo", "low"), "low");
  assert.equal(parseClaudeEffort(undefined), undefined);
  assert.equal(parseFailover("yes"), "off");
  assert.equal(parseFailover("Codex"), "codex");
  assert.equal(parseMaxConcurrentRuns("0"), 2);
  assert.equal(parseMaxConcurrentRuns("1.5"), 2);
  assert.equal(parseMaxConcurrentRuns("1"), 1);
});

test("the Henry profile keeps its own policy: Codex primary, CLI-default t1 model, no effort flag", (t) => {
  setActiveProfile("henry");
  t.after(() => setActiveProfile("kelly"));
  withEnv(t, {});
  const config = loadConfig(tempDir("henry-policy-", t));
  assert.equal(config.provider, "codex");
  assert.equal(config.claudeModel, undefined);
  assert.equal(config.claudeT0Model, "haiku");
  assert.equal(config.claudeT2Model, "opus");
  assert.equal(config.claudeEffort, undefined);
  assert.equal(config.claudeT2Effort, undefined);
  assert.equal(config.failover, undefined, "Henry's failover follows the settings.json policy alone");
});

function scriptedRunner(t: { after(fn: () => void): void }, failures: Partial<Record<ProviderName, Partial<RunResult>>>) {
  const config = loadConfig(tempDir("kelly-policy-run-", t));
  const activity = new ActivityLog(config.activityPath);
  const called: ProviderName[] = [];
  const runner = new ProviderRunner(config, activity, new AdmissionController({ samplePressure: async () => "ok" }), {
    notify: async () => undefined,
    execute: async (_command, _args, _cwd, provider): Promise<RunResult> => {
      called.push(provider);
      return { runId: `run-${provider}`, provider, response: `answer from ${provider}`, exitCode: 0, durationMs: 1, events: [], ...failures[provider] };
    },
  });
  return { runner, called, config };
}

const CLAUDE_LIMIT: Partial<RunResult> = { exitCode: 1, response: "", error: "Claude usage limit reached · resets 3pm" };

test("Kelly never fails over to Codex unless KELLY_FAILOVER=codex", async (t) => {
  setActiveProfile("kelly");
  withEnv(t, {});
  const { runner, called } = scriptedRunner(t, { claude: CLAUDE_LIMIT });
  const result = await runner.run("price of 10 switches", { timeoutMs: 5_000 });
  assert.deepEqual(called, ["claude"]);
  assert.equal(result.limited, true, "out of quota is reported as limited, not as an empty answer");
});

test("with KELLY_FAILOVER=codex an exhausted Claude hands the turn to Codex", async (t) => {
  setActiveProfile("kelly");
  withEnv(t, { KELLY_FAILOVER: "codex" });
  const { runner, called } = scriptedRunner(t, { claude: CLAUDE_LIMIT });
  const result = await runner.run("price of 10 switches", { timeoutMs: 5_000 });
  assert.deepEqual(called, ["claude", "codex"]);
  assert.equal(result.provider, "codex");
  assert.equal(result.response, "answer from codex");
});

test("a hard-pinned run never fails over, even with failover on", async (t) => {
  setActiveProfile("kelly");
  withEnv(t, { KELLY_FAILOVER: "codex" });
  const { runner, called } = scriptedRunner(t, { claude: CLAUDE_LIMIT });
  await runner.run("probe", { provider: "claude", pin: "hard", timeoutMs: 5_000 });
  assert.deepEqual(called, ["claude"]);
});

test("`kelly provider codex|claude` switches and persists Kelly's primary provider", async (t) => {
  setActiveProfile("kelly");
  withEnv(t, {});
  const root = tempDir("kelly-policy-runtime-", t);
  const runtime = await HenryRuntime.create(root);
  try {
    assert.equal(runtime.config.provider, "claude");
    assert.equal(await runtime.setProvider("codex"), "codex");
    const settings = JSON.parse(fs.readFileSync(runtime.config.settingsPath, "utf8")) as Record<string, unknown>;
    assert.equal(settings.provider, "codex");
  } finally {
    runtime.close();
  }
  const reloaded = await HenryRuntime.create(root);
  try {
    assert.equal(reloaded.config.provider, "codex", "the persisted choice wins over the Claude default");
    assert.equal(await reloaded.setProvider("claude"), "claude");
  } finally {
    reloaded.close();
  }
});
