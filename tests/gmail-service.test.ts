import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { gmail_v1 } from "googleapis";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { ApprovalStore } from "../src/approval/store.ts";
import { GmailService } from "../src/integrations/gmail.ts";

async function setup(): Promise<{
  config: ReturnType<typeof loadConfig>;
  activity: ActivityLog;
  approvals: ApprovalStore;
}> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-gmail-service-"));
  const config = loadConfig(rootDir);
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  const approvals = new ApprovalStore(config.approvalsPath);
  await approvals.init();
  return { config, activity, approvals };
}

test("inbox exposes Gmail thread id and RFC message headers", async () => {
  const { config, activity, approvals } = await setup();
  const fakeClient = {
    users: { messages: {
      list: async () => ({ data: { messages: [{ id: "gmail-id" }] } }),
      get: async () => ({ data: { id: "gmail-id", threadId: "thread-id", snippet: "Snippet", payload: {
        headers: [
          { name: "From", value: "Jane <jane@example.com>" },
          { name: "To", value: "me@example.com" },
          { name: "Subject", value: "Contract review" },
          { name: "Date", value: "Mon, 1 Sep 2026 10:00:00 +0000" },
          { name: "Message-ID", value: "<message@example.com>" },
          { name: "References", value: "<root@example.com>" },
        ],
        mimeType: "text/plain",
        body: { data: Buffer.from("Hello").toString("base64url") },
      } } }),
    } },
  } as unknown as gmail_v1.Gmail;
  const service = new GmailService(config, activity, approvals, async () => fakeClient);
  const messages = await service.inbox(1);
  assert.deepEqual(messages[0], {
    id: "gmail-id", threadId: "thread-id", messageId: "<message@example.com>", references: "<root@example.com>",
    from: "Jane <jane@example.com>", to: "me@example.com", subject: "Contract review",
    date: "Mon, 1 Sep 2026 10:00:00 +0000", snippet: "Snippet", body: "Hello",
  });
});

test("queueEmail stores thread identity, while sendApproved still requires an explicit claim", async () => {
  const { config, activity, approvals } = await setup();
  let sendCalls = 0;
  let sentRequest: unknown;
  const fakeClient = {
    users: { messages: {
      send: async (request: unknown) => { sendCalls += 1; sentRequest = request; return { data: { id: "sent-id" } }; },
    } },
  } as unknown as gmail_v1.Gmail;
  const service = new GmailService(config, activity, approvals, async () => fakeClient);
  const item = await service.queueEmail({
    to: "jane@example.com", subject: "Contract review", body: "Thanks",
    threadId: "thread-id", inReplyTo: "parent@example.com", references: "<root@example.com>",
  });

  assert.equal(item.status, "pending");
  assert.deepEqual(item.payload, {
    to: "jane@example.com", subject: "Contract review", body: "Thanks", threadId: "thread-id",
    inReplyTo: "parent@example.com", references: "<root@example.com>",
  });
  await assert.rejects(() => service.sendApproved(item), /requires Luvish's explicit approval/);
  assert.equal(sendCalls, 0);

  await approvals.setStatus(item.id, "approved");
  const executing = await approvals.claimForExecution(item.id);
  assert.equal(await service.sendApproved(executing), "sent-id");
  assert.equal(sendCalls, 1);
  const raw = Buffer.from((sentRequest as { requestBody: { raw: string } }).requestBody.raw, "base64url").toString("utf8");
  assert.match(raw, /^In-Reply-To: <parent@example\.com>\r\n/m);
  assert.match(raw, /^References: <root@example\.com> <parent@example\.com>\r\n/m);
});
