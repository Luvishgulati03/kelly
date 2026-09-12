import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type HenryConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { WorkflowScheduler } from "../src/scheduler/scheduler.ts";
import { holdInteractiveLock, interactiveBusy, waitForInteractiveIdle, INTERACTIVE_STALE_MS } from "../src/orchestration/interactive-lock.ts";
import type { HenryMemory } from "../src/memory/engram.ts";
import type { GmailService } from "../src/integrations/gmail.ts";
import type { WorkflowDefinition } from "../src/types.ts";

function tempConfig(): HenryConfig {
  return loadConfig(fs.mkdtempSync(path.join(os.tmpdir(), "henry-conc-")));
}

test("interactive lock: own holds don't count, foreign fresh holds do, stale holds don't", async () => {
  const config = tempConfig();
  assert.equal(interactiveBusy(config), false, "no lock file = idle");

  const release = holdInteractiveLock(config);
  assert.equal(interactiveBusy(config), false, "our own conversation is never contention");
  release();

  const file = path.join(config.dataDir, "interactive.lock");
  fs.writeFileSync(file, `999999:${Date.now()}`); // foreign live-looking pid, fresh heartbeat
  assert.equal(interactiveBusy(config), true, "another process mid-turn = busy");

  fs.writeFileSync(file, `999999:${Date.now() - INTERACTIVE_STALE_MS - 1}`);
  assert.equal(interactiveBusy(config), false, "stale heartbeat = crashed/finished, not contention");

  // Bounded wait: busy now, released mid-wait → returns true quickly.
  fs.writeFileSync(file, `999999:${Date.now()}`);
  setTimeout(() => fs.rmSync(file, { force: true }), 150);
  const reached = await waitForInteractiveIdle(config, 3_000, 50);
  assert.equal(reached, true);

  // Wait budget exhausted while still busy → false, caller proceeds anyway.
  fs.writeFileSync(file, `999999:${Date.now() + 60_000}`); // heartbeat that stays fresh through the wait
  const gaveUp = await waitForInteractiveIdle(config, 200, 50);
  assert.equal(gaveUp, false);
});

test("scheduler: per-workflow pid lock — concurrent firings run exactly once across processes", async () => {
  const config = tempConfig();
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  let dreams = 0;
  const memory = {
    dream: async () => { dreams += 1; await new Promise((resolve) => setTimeout(resolve, 250)); return { consolidated: true }; },
  } as unknown as HenryMemory;
  const scheduler = new WorkflowScheduler(config, activity, memory, {} as unknown as GmailService);
  const definition: WorkflowDefinition = { id: "test-dream", name: "t", cron: "* * * * *", kind: "memory.dream", enabled: true };

  // Simulate the second process: a live foreign-looking holder of the workflow lock.
  const lockPath = path.join(config.dataDir, `wf-${definition.id}.lock`);
  fs.mkdirSync(config.dataDir, { recursive: true });

  // First: uncontended run executes.
  const first = await scheduler.run(definition);
  assert.deepEqual(first, { consolidated: true });
  assert.equal(dreams, 1);
  assert.equal(fs.existsSync(lockPath), false, "lock released after the run");

  // Second: while a LIVE other pid holds the lock, the firing skips.
  fs.writeFileSync(lockPath, "1"); // pid 1 (launchd) is always alive
  const skipped = await scheduler.run(definition) as { skipped?: boolean; reason?: string };
  assert.equal(skipped.skipped, true);
  assert.match(String(skipped.reason), /already running/);
  assert.equal(dreams, 1, "the locked firing must not execute");
  fs.rmSync(lockPath, { force: true });

  // Third: two truly concurrent firings in ONE process — same-pid lock does not
  // deadlock ourselves; croner's protect handles same-job overlap in-process.
  const [a, b] = await Promise.all([scheduler.run(definition), scheduler.run(definition)]);
  assert.ok(a && b);
});
