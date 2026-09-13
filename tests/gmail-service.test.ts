import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { ApprovalStore } from "../src/approval/store.ts";
import { GmailService } from "../src/integrations/gmail.ts";
import type { ProviderRunner } from "../src/providers/runner.ts";
import type { RunResult } from "../src/types.ts";

function result(response: string): RunResult {
  return { provider: "codex", response, exitCode: 0, runId: "test", durationMs: 1, limited: false, events: [] };
}

async function setup(responses: string[]) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-gmail-service-"));
  const config = loadConfig(rootDir);
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  const approvals = new ApprovalStore(config.approvalsPath);
  await approvals.init();
  const calls: Array<{ prompt: string; options: unknown }> = [];
  const runner = { run: async (prompt: string, options: unknown) => {
    calls.push({ prompt, options });
    return result(responses.shift() || "");
  } } as unknown as ProviderRunner;
  return { activity, approvals, calls, service: new GmailService(activity, approvals, runner) };
}

test("inbox uses the Codex Gmail connector read-only", async () => {
  const payload = { messages: [{
    id: "gmail-id", threadId: "thread-id", messageId: "<message@example.com>", references: "<root@example.com>",
    from: "Jane <jane@example.com>", to: "me@example.com", subject: "Contract review",
    date: "Mon, 1 Sep 2026 10:00:00 +0000", snippet: "Snippet", body: "Hello",
  }] };
  const { service, calls } = await setup([JSON.stringify(payload)]);
  assert.deepEqual(await service.inbox(1), payload.messages);
  assert.match(calls[0]!.prompt, /configured Gmail connector directly/);
  assert.equal((calls[0]!.options as { provider: string }).provider, "codex");
  assert.equal((calls[0]!.options as { readOnly: boolean }).readOnly, true);
  assert.equal((calls[0]!.options as { role: string }).role, "gmail-inbox");
});

test("connector send receives exact content only after an explicit claim", async () => {
  const { service, approvals, calls } = await setup([JSON.stringify({ sent: true, messageId: "sent-id", error: null })]);
  const item = await service.queueEmail({
    to: "jane@example.com", subject: "Contract review", body: "Thanks",
    threadId: "thread-id", inReplyTo: "parent@example.com", references: "<root@example.com>",
  });
  await assert.rejects(() => service.sendApproved(item), /requires Luvish's explicit approval/);
  assert.equal(calls.length, 0);
  await approvals.setStatus(item.id, "approved");
  const executing = await approvals.claimForExecution(item.id);
  assert.equal(await service.sendApproved(executing), "sent-id");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.prompt, /SEND exactly one email/);
  assert.match(calls[0]!.prompt, /jane@example\.com/);
  assert.equal((calls[0]!.options as { provider: string }).provider, "codex");
  assert.equal((calls[0]!.options as { readOnly: boolean }).readOnly, false);
  assert.equal((calls[0]!.options as { role: string }).role, "gmail-approved-send");
});
