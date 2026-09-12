import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setActiveProfile } from "../src/profile.ts";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { ProviderRunner } from "../src/providers/runner.ts";
import { AdmissionController } from "../src/orchestration/admission.ts";
import type { ProviderName, RunResult } from "../src/types.ts";

test("Kelly never falls back from Codex to Claude", async () => {
  setActiveProfile("kelly");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kelly-codex-only-"));
  const config = loadConfig(root); const activity = new ActivityLog(config.activityPath); await activity.init();
  const called: ProviderName[] = [];
  const runner = new ProviderRunner(config, activity, new AdmissionController({ maxConcurrent: 1, samplePressure: async () => "ok" }), {
    execute: async (_command, _args, _cwd, provider): Promise<RunResult> => {
      called.push(provider);
      return { runId: "kelly-codex-only", provider, response: "", exitCode: 1, durationMs: 1, error: "ordinary failure", events: [] };
    },
  });
  await runner.run("test");
  assert.deepEqual(called, ["codex"]);
  assert.equal(config.provider, "codex");
  assert.equal(config.claudeModel, undefined);
});
