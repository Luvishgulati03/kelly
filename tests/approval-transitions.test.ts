import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApprovalStore } from "../src/approval/store.ts";

test("approval store rejects transitions after an action has executed", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-approval-edge-"));

  try {
    const store = new ApprovalStore(path.join(rootDir, "approvals.json"));
    const item = await store.create({
      kind: "gmail.send",
      title: "Test outbound message",
      body: "Deterministic test body",
      payload: { to: "recipient@example.com" },
    });

    await store.setStatus(item.id, "approved");
    await store.setStatus(item.id, "executing");
    await store.setStatus(item.id, "executed", "message-123");
    await assert.rejects(() => store.setStatus(item.id, "rejected"), /Invalid approval transition: executed -> rejected/);

    const persisted = await store.get(item.id);
    assert.equal(persisted?.status, "executed");
    assert.equal(persisted?.result, "message-123");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("approval store cannot claim a pending action for outbound execution", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-approval-claim-"));

  try {
    const store = new ApprovalStore(path.join(rootDir, "approvals.json"));
    await store.init();
    const item = await store.create({
      kind: "gmail.send",
      title: "Pending email",
      body: "Must not send",
      payload: { to: "recipient@example.com" },
    });

    await assert.rejects(
      () => store.claimForExecution(item.id),
      /Luvish's explicit approval is required before execution/,
    );
    await store.setStatus(item.id, "approved");
    const claimed = await store.claimForExecution(item.id);
    assert.equal(claimed.status, "executing");
    await assert.rejects(() => store.claimForExecution(item.id), /Luvish's explicit approval/);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

/**
 * Two SEPARATE ApprovalStore instances over one file stand in for the REPL/CLI, the
 * dashboard and the scheduler — which really are separate processes sharing this file.
 * The in-process mutation chain cannot see across them, so before the file lock both
 * could read the item as `approved` and both write `executing`. For a job application
 * that is a second application landing on a real employer's desk.
 */
test("approval store: only one of two independent stores can claim the same item", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-approval-race-"));
  try {
    const filePath = path.join(rootDir, "approvals.json");
    const author = new ApprovalStore(filePath);
    const created = await author.create({
      kind: "job.application",
      title: "Apply to Acme",
      body: "one application only",
      payload: { applicationId: "app-1" },
    });
    await author.setStatus(created.id, "approved");

    // Two stores that have never shared memory, racing for the same claim.
    const a = new ApprovalStore(filePath);
    const b = new ApprovalStore(filePath);
    const results = await Promise.allSettled([a.claimForExecution(created.id), b.claimForExecution(created.id)]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");

    assert.equal(won.length, 1, "exactly one claim may succeed — two means a duplicate submission");
    assert.equal(lost.length, 1, "the loser must be refused, not silently allowed through");
    assert.match(
      String((lost[0] as PromiseRejectedResult).reason),
      /executing|explicit approval/i,
      "the refusal should name the already-claimed state",
    );

    // And the file agrees, so a third process reading fresh sees the claim.
    const observer = new ApprovalStore(filePath);
    const [persisted] = (await observer.list()).filter((entry) => entry.id === created.id);
    assert.equal(persisted?.status, "executing");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("approval store: a stale lock left by a dead process does not block forever", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-approval-stale-"));
  try {
    const filePath = path.join(rootDir, "approvals.json");
    const store = new ApprovalStore(filePath);
    await store.create({ kind: "message.send", title: "seed", body: "seed", payload: {} });

    // A lock file whose owner never released it, aged well past the staleness window.
    const lockPath = `${filePath}.lock`;
    await fs.writeFile(lockPath, "999999", "utf8");
    const old = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(lockPath, old, old);

    const item = await store.create({ kind: "message.send", title: "after stale", body: "b", payload: {} });
    assert.ok(item.id, "a stale lock must be broken rather than deadlocking every later mutation");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
