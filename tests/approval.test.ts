import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApprovalStore } from "../src/approval/store.ts";

test("approval store keeps outbound actions pending until explicitly approved", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-approval-"));
  const store = new ApprovalStore(path.join(dir, "approvals.json"));
  await store.init();
  const item = await store.create({ kind: "gmail.send", title: "Test", body: "Hello", payload: { to: "someone@example.com" } });
  assert.equal(item.status, "pending");
  await assert.rejects(() => store.setStatus(item.id, "executed"));
  await store.setStatus(item.id, "approved");
  assert.equal((await store.get(item.id))?.status, "approved");
});
