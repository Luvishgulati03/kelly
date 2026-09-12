import test from "node:test";
import assert from "node:assert/strict";
import { explicitApprovalTarget, executeExplicitApproval } from "../src/approval/explicit.ts";
import type { ApprovalItem } from "../src/types.ts";

const item: ApprovalItem = {
  id: "12345678-1234-1234-1234-123456789abc", createdAt: "", updatedAt: "", kind: "social.x-post", status: "pending",
  title: "Post to X", body: "bengaluru weather>>>>", payload: { text: "bengaluru weather>>>>" },
};

test("explicit approvals support IDs, exact bodies, and contextual tweets", () => {
  assert.deepEqual(explicitApprovalTarget("APPROVE 12345678-1234-1234-1234-123456789abc"), { id: item.id });
  assert.deepEqual(explicitApprovalTarget("I explicitly approve: bengaluru weather>>>>"), { body: item.body });
  assert.deepEqual(explicitApprovalTarget("approve it"), { contextual: true });
  assert.deepEqual(explicitApprovalTarget("tweet this and it's approved"), { contextual: true });
});

test("contextual approval executes the only pending tweet", async () => {
  const calls: string[] = [];
  const result = await executeExplicitApproval({
    approvals: { list: async () => [item] },
    approve: async (id) => { calls.push(`approve:${id}`); },
    executeApproval: async (id) => { calls.push(`execute:${id}`); return "Posted to X"; },
  }, "tweet this and it's approved");
  assert.equal(result, "Posted to X");
  assert.deepEqual(calls, [`approve:${item.id}`, `execute:${item.id}`]);
});

test("contextual approval cannot select email actions", async () => {
  const email = { ...item, id: "22345678-1234-1234-1234-123456789abc", kind: "email.draft" as ApprovalItem["kind"] };
  const result = await executeExplicitApproval({
    approvals: { list: async () => [email] },
    approve: async () => assert.fail("email must not be approved contextually"),
    executeApproval: async () => assert.fail("email must not execute contextually"),
  }, "approve it");
  assert.equal(result, "No pending tweet matches that approval.");
});

test("contextual approval asks for clarification when multiple tweets are pending", async () => {
  const second = { ...item, id: "32345678-1234-1234-1234-123456789abc" };
  const result = await executeExplicitApproval({
    approvals: { list: async () => [item, second] },
    approve: async () => assert.fail("ambiguous tweets must not be approved"),
    executeApproval: async () => assert.fail("ambiguous tweets must not execute"),
  }, "approve this");
  assert.equal(result, "More than one tweet is pending; approve the exact tweet or use its ID.");
});

test("an exact local approval records approval then executes", async () => {
  const calls: string[] = [];
  const result = await executeExplicitApproval({
    approvals: { list: async () => [item] },
    approve: async (id) => { calls.push(`approve:${id}`); },
    executeApproval: async (id) => { calls.push(`execute:${id}`); return "Posted to X"; },
  }, "APPROVE: bengaluru weather>>>>");
  assert.equal(result, "Posted to X");
  assert.deepEqual(calls, [`approve:${item.id}`, `execute:${item.id}`]);
});
