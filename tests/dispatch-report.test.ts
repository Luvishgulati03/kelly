import test from "node:test";
import assert from "node:assert/strict";
import { isLongResearchAsk } from "../src/orchestration/luna.ts";

test("long research routing requires explicit depth or a substantial deliverable", () => {
  assert.equal(isLongResearchAsk("Do an in-depth research plan for Henry's latency."), true);
  assert.equal(isLongResearchAsk("Deep research this topic and cite the sources."), true);
  assert.equal(isLongResearchAsk(`Research the agent orchestration landscape and prepare a recommendation report with primary sources. ${"Include tradeoffs. ".repeat(8)}`), true);
  assert.equal(isLongResearchAsk("Research Redis quickly."), false);
  assert.equal(isLongResearchAsk("Please fix this complex production bug."), false);
});
