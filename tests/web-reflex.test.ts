import test from "node:test";
import assert from "node:assert/strict";
import { reflexKind } from "../src/reflex.ts";

test("web uses the shared narrow reflex matcher and keeps judgment on the brain path", () => {
  assert.equal(reflexKind("what are you working on?"), "working");
  assert.equal(reflexKind("anything pending?"), "pending");
  assert.equal(reflexKind("status"), "alive");
  assert.equal(reflexKind("what do you think we should do about the pending approval UX?"), undefined);
  assert.equal(reflexKind("who is the president of Germany and what are they up to?"), undefined);
  assert.equal(reflexKind("which provider are you using?"), undefined);
});
