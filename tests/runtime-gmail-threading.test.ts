import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HenryRuntime } from "../src/runtime.ts";
import type { RunResult } from "../src/types.ts";

test("runtime draftreplies adapter stages thread identity and never sends", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-runtime-gmail-threading-"));
  const runtime = await HenryRuntime.create(rootDir);
  try {
    const response = [
      "DRAFT_BEGIN",
      "To: jane@example.com",
      "Subject: Re: Contract review",
      "Body:",
      "Thanks — I will review it.",
      "DRAFT_END",
      "DRAFTED|jane@example.com|Re: Contract review|Thanks — I will review it.",
    ].join("\n");
    const runner = runtime.agent.providerRunner as unknown as {
      run: (prompt: string, options?: Record<string, unknown>) => Promise<RunResult>;
    };
    runner.run = async () => ({
      runId: "runtime-gmail-threading", provider: "codex", response, exitCode: 0, durationMs: 1, events: [],
    });

    const gmail = runtime.gmail as unknown as {
      inbox: (limit?: number) => Promise<unknown[]>;
    };
    gmail.inbox = async (limit) => {
      assert.equal(limit, 20, "threading adapter should read enough recent messages to match drafts");
      return [{
        id: "gmail-message-id", threadId: "gmail-thread-id", messageId: "<parent@example.com>",
        references: "<root@example.com>", from: "Jane <jane@example.com>", subject: "Contract review",
      }];
    };

    assert.ok(runtime.draftReplies, "draftReplies service should be available");
    // A regression test must never leak into the operator's macOS notifications.
    (runtime.draftReplies as unknown as { notify?: (message: string, title?: string) => Promise<void> }).notify = async () => undefined;
    const result = await runtime.draftReplies.draftReplies(1);
    assert.equal(result.staged.length, 1);
    assert.deepEqual(result.staged, [{
      approvalId: result.staged[0].approvalId,
      to: "jane@example.com", subject: "Re: Contract review", threadId: "gmail-thread-id",
      inReplyTo: "<parent@example.com>", unthreaded: false,
    }]);
    const approval = await runtime.approvals.get(result.staged[0].approvalId);
    assert.equal(approval?.status, "pending", "drafting must stage, not execute");
    assert.deepEqual(approval?.payload, {
      to: "jane@example.com", subject: "Re: Contract review", body: "Thanks — I will review it.",
      threadId: "gmail-thread-id", inReplyTo: "<parent@example.com>", references: "<root@example.com>",
    });
  } finally {
    runtime.close();
  }
});
