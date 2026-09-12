import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActivityLog } from "../src/activity.ts";
import { HenryMemory } from "../src/memory/engram.ts";
import type { HenryConfig } from "../src/config.ts";
import { loadConfig } from "../src/config.ts";
import { readRecallTraces } from "../src/metrics/recall-metrics.ts";

function config(rootDir: string): HenryConfig {
  return {
    ...loadConfig(rootDir),
    rootDir, dataDir: path.join(rootDir, "data"), memoryDir: path.join(rootDir, "memory"), capturedMemoryDir: path.join(rootDir, "memory/captured"),
    dbPath: path.join(rootDir, "data/engram.db"), activityPath: path.join(rootDir, "data/activity.jsonl"), approvalsPath: path.join(rootDir, "data/approvals.json"), workflowsPath: path.join(rootDir, "workflows.json"),
    host: "127.0.0.1", port: 0, dashboardToken: undefined, allowRemoteDashboard: false, provider: "codex", requireOutboundApproval: true, gmailCredentialsPath: path.join(rootDir, "credentials.json"), gmailTokenPath: path.join(rootDir, "token.json"), gmailRedirectUri: "http://127.0.0.1:43821/oauth2callback",
  };
}

test("Engram memory survives index and recalls a durable decision", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "henry-memory-"));
  const cfg = config(root);
  const activity = new ActivityLog(cfg.activityPath);
  await activity.init();
  const memory = new HenryMemory(cfg, activity);
  await memory.init();
  const id = await memory.remember("The canary deploy must finish before the database migration is promoted.", { tier: "procedural", importance: 9 });
  const hits = await memory.recall("what must happen before promoting the database migration?");
  assert.ok(hits.some((hit) => hit.id === id || hit.content.includes("canary deploy")));
  assert.ok(hits[0]?.why);
  const context = await memory.context("what must happen before promoting the database migration?");
  assert.match(context, /canary deploy/);
  const deadline = Date.now() + 1_000;
  let traces = await readRecallTraces(cfg);
  while (!traces.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    traces = await readRecallTraces(cfg);
  }
  assert.equal(traces.length, 1);
  assert.equal(traces[0].used, 1);
  assert.equal(traces[0].memories[0].outcome, "used");
  const traceFile = await fs.readFile(path.join(cfg.metricsDir, "recall-traces.jsonl"), "utf8");
  assert.doesNotMatch(traceFile, /canary deploy must finish/);
  await memory.index();
  memory.close();
});
