import test from "node:test";
import assert from "node:assert/strict";
import { createInputQueue } from "../src/repl/input-queue.ts";

test("input queue is idle and empty before any run starts", () => {
  const queue = createInputQueue();
  assert.equal(queue.busy, false);
  assert.equal(queue.length, 0);
  assert.equal(queue.finish(), undefined);
});

test("push only makes sense once a run has started, and finish drains everything joined by newline", () => {
  const queue = createInputQueue();
  queue.start();
  assert.equal(queue.busy, true);
  assert.equal(queue.push("first message"), 1);
  assert.equal(queue.push("second message"), 2);
  assert.equal(queue.push("third message"), 3);
  assert.equal(queue.length, 3);

  const drained = queue.finish();
  assert.ok(drained);
  assert.equal(drained!.count, 3);
  assert.equal(drained!.combined, "first message\nsecond message\nthird message");
  // finish() flips busy back off and empties the buffer.
  assert.equal(queue.busy, false);
  assert.equal(queue.length, 0);
});

test("finish() returns undefined when nothing was queued during the run", () => {
  const queue = createInputQueue();
  queue.start();
  assert.equal(queue.finish(), undefined);
  assert.equal(queue.busy, false);
});

test("a single queued message drains with count 1 (caller decides whether to label it)", () => {
  const queue = createInputQueue();
  queue.start();
  queue.push("reply OK only");
  const drained = queue.finish();
  assert.deepEqual(drained, { combined: "reply OK only", count: 1 });
});

test("queue can be reused across multiple start/finish cycles", () => {
  const queue = createInputQueue();
  queue.start();
  queue.push("a");
  assert.deepEqual(queue.finish(), { combined: "a", count: 1 });

  queue.start();
  queue.push("b");
  queue.push("c");
  assert.deepEqual(queue.finish(), { combined: "b\nc", count: 2 });
});

test("pending exposes a read-only snapshot without draining", () => {
  const queue = createInputQueue();
  queue.start();
  queue.push("first");
  queue.push("second");
  assert.deepEqual(queue.pending(), ["first", "second"]);
  assert.equal(queue.length, 2); // peek must not drain
  const snapshot = queue.pending() as string[];
  snapshot.push("mutated");
  assert.equal(queue.length, 2); // snapshot mutation must not leak back
  assert.deepEqual(queue.finish(), { combined: "first\nsecond", count: 2 });
  assert.deepEqual(queue.pending(), []);
});
