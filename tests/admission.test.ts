import test from "node:test";
import assert from "node:assert/strict";
import {
  AdmissionController,
  parseMemoryPressure,
  sharedAdmissionController,
  setSharedAdmissionController,
  type MemoryPressureLevel,
} from "../src/orchestration/admission.ts";

function controller(pressure: () => MemoryPressureLevel, options: { maxConcurrent?: number; maxHeavy?: number } = {}): AdmissionController {
  return new AdmissionController({
    maxConcurrent: options.maxConcurrent ?? 2,
    maxHeavy: options.maxHeavy ?? 1,
    pressureTtlMs: 0,
    samplePressure: async () => pressure(),
  });
}

async function admit(admission: AdmissionController, provider: "codex" | "claude", timeoutMs = 1_000) {
  return await admission.waitForSlot({ provider, timeoutMs });
}

test("admission grants up to two concurrent slots and blocks the third", async () => {
  const admission = controller(() => "ok");
  const first = await admit(admission, "codex");
  const second = await admit(admission, "codex");
  assert.equal(first.admitted, true);
  assert.equal(second.admitted, true);
  assert.equal(admission.runningCount, 2);

  let thirdAdmitted = false;
  const third = admit(admission, "codex").then((decision) => { thirdAdmitted = decision.admitted; return decision; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(thirdAdmitted, false, "third request must wait for a free slot");
  assert.equal(admission.queuedCount, 1);

  if (first.admitted) first.slot.release();
  const decision = await third;
  assert.equal(decision.admitted, true);
  assert.equal(admission.runningCount, 2);
  if (second.admitted) second.slot.release();
  if (decision.admitted) decision.slot.release();
  assert.equal(admission.runningCount, 0);
});

test("only one heavy (claude) subprocess runs at a time", async () => {
  const admission = controller(() => "ok");
  const heavy = await admit(admission, "claude");
  assert.equal(heavy.admitted, true);

  const light = await admit(admission, "codex");
  assert.equal(light.admitted, true, "a light worker may pair with the heavy one");

  let secondHeavyDone = false;
  const secondHeavy = admit(admission, "claude").then((decision) => { secondHeavyDone = true; return decision; });
  if (light.admitted) light.slot.release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondHeavyDone, false, "second heavy worker waits even with a free general slot");

  if (heavy.admitted) heavy.slot.release();
  const decision = await secondHeavy;
  assert.equal(decision.admitted, true);
  if (decision.admitted) decision.slot.release();
});

test("queue is served first-in-first-out", async () => {
  const admission = controller(() => "ok", { maxConcurrent: 1 });
  const held = await admit(admission, "codex");
  assert.equal(held.admitted, true);

  const order: string[] = [];
  const waiters = ["a", "b", "c"].map((label, index) =>
    new Promise<void>((resolve) => {
      setTimeout(() => {
        void admission.waitForSlot({ provider: "codex", timeoutMs: 2_000 }).then((decision) => {
          order.push(label);
          if (decision.admitted) decision.slot.release();
          resolve();
        });
      }, index * 5);
    }));

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(admission.queuedCount, 3);
  if (held.admitted) held.slot.release();
  await Promise.all(waiters);
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("critical memory pressure refuses the spawn instead of queueing forever", async () => {
  let level: MemoryPressureLevel = "critical";
  const admission = controller(() => level);
  const refused = await admit(admission, "codex");
  assert.equal(refused.admitted, false);
  if (!refused.admitted) {
    assert.equal(refused.reason, "pressure");
    assert.equal(refused.pressure, "critical");
  }
  assert.equal(admission.runningCount, 0);
  assert.equal(admission.queuedCount, 0);

  level = "ok";
  const allowed = await admit(admission, "codex");
  assert.equal(allowed.admitted, true, "recovery from critical pressure re-opens admission");
  if (allowed.admitted) allowed.slot.release();
});

test("warn pressure collapses the pool to a single worker", async () => {
  const admission = controller(() => "warn");
  const first = await admit(admission, "codex");
  assert.equal(first.admitted, true);

  let secondDone = false;
  const second = admit(admission, "codex", 60).then((decision) => { secondDone = true; return decision; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondDone, false, "warn pressure pauses additional spawns");
  const decision = await second;
  assert.equal(decision.admitted, false);
  if (!decision.admitted) assert.equal(decision.reason, "timeout");
  if (first.admitted) first.slot.release();
});

test("waiting past the timeout releases the waiter and clears the queue", async () => {
  const admission = controller(() => "ok", { maxConcurrent: 1 });
  const held = await admit(admission, "codex");
  assert.equal(held.admitted, true);

  const started = Date.now();
  const timedOut = await admit(admission, "codex", 50);
  assert.equal(timedOut.admitted, false);
  if (!timedOut.admitted) {
    assert.equal(timedOut.reason, "timeout");
    assert.ok(timedOut.queuedMs >= 40, `queuedMs should reflect the wait, got ${timedOut.queuedMs}`);
  }
  assert.ok(Date.now() - started < 1_000);
  assert.equal(admission.queuedCount, 0, "timed-out waiter must leave the queue");

  if (held.admitted) held.slot.release();
  const after = await admit(admission, "codex");
  assert.equal(after.admitted, true);
  if (after.admitted) after.slot.release();
});

test("releasing a slot twice does not free extra capacity", async () => {
  const admission = controller(() => "ok", { maxConcurrent: 1 });
  const slot = await admit(admission, "codex");
  assert.equal(slot.admitted, true);
  if (slot.admitted) {
    slot.slot.release();
    slot.slot.release();
  }
  assert.equal(admission.runningCount, 0);
});

test("memory_pressure output parses into ok/warn/critical bands", () => {
  const header = "The system has 8589934592 (524288 pages with a page size of 16384).\n";
  assert.equal(parseMemoryPressure(`${header}System-wide memory free percentage: 46%`), "ok");
  assert.equal(parseMemoryPressure(`${header}System-wide memory free percentage: 10%`), "ok");
  assert.equal(parseMemoryPressure(`${header}System-wide memory free percentage: 9%`), "warn");
  assert.equal(parseMemoryPressure(`${header}System-wide memory free percentage: 5%`), "warn");
  assert.equal(parseMemoryPressure(`${header}System-wide memory free percentage: 4%`), "critical");
  assert.equal(parseMemoryPressure("command not found"), "ok", "unparseable output assumes healthy");
  assert.equal(parseMemoryPressure(""), "ok");
});

test("the shared controller is a process-wide singleton every runner can reach", () => {
  const original = sharedAdmissionController();
  assert.equal(sharedAdmissionController(), original);
  const injected = new AdmissionController({ samplePressure: async () => "ok" });
  setSharedAdmissionController(injected);
  assert.equal(sharedAdmissionController(), injected);
  setSharedAdmissionController(original);
  assert.equal(sharedAdmissionController(), original);
});

test("snapshot reports live pool state for the dashboard", async () => {
  const admission = controller(() => "ok");
  const slot = await admit(admission, "claude");
  const snapshot = admission.snapshot();
  assert.equal(snapshot.running, 1);
  assert.equal(snapshot.heavyRunning, 1);
  assert.equal(snapshot.queued, 0);
  assert.equal(snapshot.pressure, "ok");
  if (slot.admitted) slot.slot.release();
});
