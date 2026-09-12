import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import type { HenryMemory } from "../src/memory/engram.ts";
import { LunaOrchestrator } from "../src/orchestration/luna.ts";
import { AgentRegistry, setSharedAgentRegistry, sharedAgentRegistry } from "../src/orchestration/agent-registry.ts";
import type { RunResult } from "../src/types.ts";

function fakeMemory(): HenryMemory {
  return { remember: async () => "mem-id" } as unknown as HenryMemory;
}

async function setup(): Promise<{ luna: LunaOrchestrator; runnerStub: { run: (...args: unknown[]) => Promise<RunResult> } }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-registry-"));
  const config = loadConfig(rootDir);
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  const luna = new LunaOrchestrator(config, activity, fakeMemory());
  // LunaOrchestrator builds its own ProviderRunner internally; swap its `run`
  // so dispatch() never actually spawns a provider process.
  const runnerStub = { run: async (): Promise<RunResult> => ({ runId: "run-1", provider: "codex", response: "All good.\nDetails.", exitCode: 0, durationMs: 1, events: [] }) };
  (luna as unknown as { runner: unknown }).runner = runnerStub;
  return { luna, runnerStub };
}

test("registry: a dispatch appears as running then flips to done", async () => {
  setSharedAgentRegistry(new AgentRegistry());
  const { luna, runnerStub } = await setup();
  let seenRunning = false;
  let resolveRun!: () => void;
  const gate = new Promise<void>((resolve) => { resolveRun = resolve; });
  runnerStub.run = async () => {
    seenRunning = sharedAgentRegistry().snapshot().running.length === 1;
    await gate;
    return { runId: "run-1", provider: "codex", response: "Done thing.", exitCode: 0, durationMs: 1, events: [] };
  };
  const dispatched = luna.dispatch("architect", "look into the thing");
  // Give the microtask queue a turn so registry.start() has run before we inspect it.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sharedAgentRegistry().snapshot().running.length, 1);
  resolveRun();
  await dispatched;
  assert.ok(seenRunning, "entry must be visible as running while the dispatch is in flight");
  const after = sharedAgentRegistry().snapshot();
  assert.equal(after.running.length, 0);
  assert.equal(after.recent.length, 1);
  const entry = after.recent[0];
  assert.equal(entry.status, "done");
  assert.equal(entry.role, "architect");
  assert.equal(entry.provider, "codex");
  assert.equal(entry.summary, "Done thing.");
  assert.ok(entry.startedAt);
  assert.ok(entry.finishedAt);
});

test("registry: a throwing dispatch flips to failed and never stays running", async () => {
  setSharedAgentRegistry(new AgentRegistry());
  const { luna, runnerStub } = await setup();
  runnerStub.run = async () => { throw new Error("provider crashed"); };
  await assert.rejects(() => luna.dispatch("architect", "do a thing"), /provider crashed/);
  const snapshot = sharedAgentRegistry().snapshot();
  assert.equal(snapshot.running.length, 0, "no ghost running row after a throw");
  assert.equal(snapshot.recent.length, 1);
  assert.equal(snapshot.recent[0].status, "failed");
  assert.equal(snapshot.recent[0].summary, "provider crashed");
});

test("registry: a non-zero exit flips to failed with the run error as summary", async () => {
  setSharedAgentRegistry(new AgentRegistry());
  const { luna, runnerStub } = await setup();
  runnerStub.run = async () => ({ runId: "run-1", provider: "codex", response: "", exitCode: 1, durationMs: 1, error: "boom", events: [] });
  await luna.dispatch("architect", "do a thing");
  const snapshot = sharedAgentRegistry().snapshot();
  assert.equal(snapshot.recent[0].status, "failed");
  assert.equal(snapshot.recent[0].summary, "boom");
});

test("registry: recent list is bounded", async () => {
  const registry = new AgentRegistry();
  for (let i = 0; i < 30; i += 1) {
    const id = registry.start("architect", `task ${i}`, "codex");
    registry.settle(id, "done", { summary: `ok ${i}` });
  }
  const snapshot = registry.snapshot();
  assert.ok(snapshot.recent.length <= 20, `expected recent to be bounded, got ${snapshot.recent.length}`);
  assert.equal(snapshot.recent[0].summary, "ok 29", "most recent stays at the front");
});

test("registry: task text is truncated for display", () => {
  const registry = new AgentRegistry();
  const longTask = "x".repeat(500);
  const id = registry.start("architect", longTask, "codex");
  const running = registry.snapshot().running[0];
  assert.ok(running.task.length <= 200);
  assert.notEqual(id, undefined);
});

test("registry: settle on an unknown id is a harmless no-op", () => {
  const registry = new AgentRegistry();
  assert.doesNotThrow(() => registry.settle("does-not-exist", "done", { summary: "x" }));
});

test("registry: a write failure at dispatch time never breaks or blocks the dispatch", async () => {
  setSharedAgentRegistry(new AgentRegistry());
  // Make the shared registry's start() throw to simulate a registry-layer bug;
  // dispatch must still complete and return the provider result untouched.
  const registry = sharedAgentRegistry();
  const originalStart = registry.start.bind(registry);
  (registry as unknown as { start: unknown }).start = () => { throw new Error("registry exploded"); };
  const { luna } = await setup();
  const result = await luna.dispatch("architect", "do a thing");
  assert.equal(result.response, "All good.\nDetails.");
  (registry as unknown as { start: typeof originalStart }).start = originalStart;
});

test("registry: process restart leaves no ghost running rows (fresh registry has none)", () => {
  // The registry is process-memory only and constructed fresh per process, so a
  // restart naturally starts empty — nothing to reconcile.
  const registry = new AgentRegistry();
  assert.deepEqual(registry.snapshot(), { running: [], recent: [] });
});

test("registry: changesSince reports new entries once and only once", () => {
  const registry = new AgentRegistry();
  const first = registry.changesSince(0);
  assert.equal(first.entries.length, 0);
  const id = registry.start("architect", "task", "codex");
  const second = registry.changesSince(first.seq);
  assert.equal(second.entries.length, 1);
  assert.equal(second.entries[0].id, id);
  const third = registry.changesSince(second.seq);
  assert.equal(third.entries.length, 0, "already-seen changes are not repeated");
  registry.settle(id, "done");
  const fourth = registry.changesSince(second.seq);
  assert.equal(fourth.entries.length, 1);
  assert.equal(fourth.entries[0].status, "done");
});

test("dispatch-and-report acknowledges immediately and pins research to Sol's low tier", async () => {
  setSharedAgentRegistry(new AgentRegistry());
  const { luna, runnerStub } = await setup();
  let resolveRun!: (value: RunResult) => void;
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  runnerStub.run = (prompt: unknown, options: unknown) => {
    calls.push({ prompt: String(prompt), options: options as Record<string, unknown> });
    return new Promise<RunResult>((resolve) => { resolveRun = resolve; });
  };

  const handle = luna.dispatchAndReport("Do deep research on durable agent queues.");
  assert.equal(handle.acknowledgement, "Started — I'll report back.");
  assert.equal(calls.length, 0, "the caller gets one render/send turn before dispatch starts");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.provider, "codex");
  assert.equal(calls[0].options.tier, "t1");
  assert.equal(calls[0].options.role, "research");
  assert.equal(calls[0].options.readOnly, true);
  resolveRun({ runId: "research-1", provider: "codex", response: "Report ready.", exitCode: 0, durationMs: 1, events: [] });
  assert.equal((await handle.completion).response, "Report ready.");
});
