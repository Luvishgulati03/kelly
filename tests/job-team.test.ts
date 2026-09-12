import test from "node:test";
import assert from "node:assert/strict";
import { runApplicationTeam } from "../src/jobs/team.ts";
import type { ProviderRunner, RunOptions } from "../src/providers/runner.ts";
import type { ActivityLog } from "../src/activity.ts";

const activity = { record: async () => {} } as unknown as ActivityLog;
function fake(responses: Array<{ response: string; exitCode: number; error?: string }>) {
  const calls: Array<{ prompt: string; options: RunOptions }> = [];
  const runner = { run: async (prompt: string, options: RunOptions) => { calls.push({ prompt, options }); return responses[calls.length - 1]; } } as unknown as ProviderRunner;
  return { runner, calls };
}
test("manager uses two sequential read-only bounded specialists, no sessions or approvals", async () => {
  const { runner, calls } = fake([{ response: '{"answers":{"name":"Candidate"}}', exitCode: 0 }, { response: '{"accepted":true,"issues":[]}', exitCode: 0 }]);
  const result = await runApplicationTeam(runner, activity, "Verified facts", JSON.parse);
  assert.equal(result.review.accepted, true);
  assert.equal(result.review.draftHash.length, 64);
  assert.deepEqual(calls.map(c => c.options.role), ["resume-tailor", "application-review"]);
  for (const call of calls) {
    assert.equal(call.options.readOnly, true);
    assert.equal(call.options.timeoutMs, 120_000);
    assert.equal(call.options.surface, undefined);
    assert.match(call.prompt, /Do not spawn agents/);
  }
  assert.match(calls[1].prompt, /Candidate/);
});
test("review failures and contradictory verdicts fail closed with no retry loop", async () => {
  for (const verdict of ['{}', 'not json', '{"accepted":true,"issues":["Invented experience"]}', '{"accepted":false,"issues":[]}']) {
    const { runner, calls } = fake([{ response: '{}', exitCode: 0 }, { response: verdict, exitCode: 0 }]);
    await assert.rejects(runApplicationTeam(runner, activity, "facts", JSON.parse), /review/i);
    assert.equal(calls.length, 2);
  }
});
test("invalid draft or provider error stops before another model call", async () => {
  const { runner, calls } = fake([{ response: 'bad json', exitCode: 0 }]);
  await assert.rejects(runApplicationTeam(runner, activity, "facts", JSON.parse));
  assert.equal(calls.length, 1);
  const failure = fake([{ response: '{}', exitCode: 0, error: "usage limit" }]);
  await assert.rejects(runApplicationTeam(failure.runner, activity, "facts", JSON.parse), /usage limit/);
  assert.equal(failure.calls.length, 1);
});
test("oversize context is rejected, never silently truncated", async () => {
  const { runner, calls } = fake([]);
  await assert.rejects(runApplicationTeam(runner, activity, "x".repeat(100_001), JSON.parse), /budget/);
  assert.equal(calls.length, 0);
});
