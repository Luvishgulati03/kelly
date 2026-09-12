import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JobApplicationStore } from "../src/jobs/store.ts";
import type { JobApplicationDraft, JobPosting } from "../src/jobs/types.ts";

function posting(n: number): JobPosting {
  return {
    id: `posting-${n}`, url: `https://boards.example.com/jobs/${n}`, source: "generic",
    title: `Role ${n}`, company: `Company ${n}`, description: "JD text.",
    descriptionHash: `hash-${n}`, questions: [], discoveredAt: new Date().toISOString(),
  };
}

function draft(n: number): Omit<JobApplicationDraft, "id" | "createdAt" | "updatedAt"> {
  return {
    posting: posting(n), coverLetter: `letter ${n}`, answers: {}, rationale: {},
    missingFacts: [], memoryIds: [], status: "discovered",
  };
}

test("mutations re-read the file first — a second instance's stale in-memory copy never clobbers cross-process writes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-jobstore-"));
  const filePath = path.join(dir, "applications.json");
  // Two instances ≈ two processes: both load the (empty) file up front.
  const a = new JobApplicationStore(filePath);
  const b = new JobApplicationStore(filePath);
  await a.init();
  await b.init();

  const first = await a.create(draft(1));
  // b's in-memory array is still [] — its create must re-read and KEEP a's entry.
  const second = await b.create(draft(2));

  const onDisk = JSON.parse(await fs.readFile(filePath, "utf8")) as JobApplicationDraft[];
  assert.equal(onDisk.length, 2, "the whole-file write must not erase the other instance's entry");
  assert.deepEqual(onDisk.map((item) => item.id).sort(), [first.id, second.id].sort());

  // Same for update(): a mutates through a copy that never saw b's entry.
  await a.update(first.id, { status: "drafted" });
  const afterUpdate = JSON.parse(await fs.readFile(filePath, "utf8")) as JobApplicationDraft[];
  assert.equal(afterUpdate.length, 2, "update() must not clobber either entry");
  assert.equal(afterUpdate.find((item) => item.id === first.id)?.status, "drafted");
  assert.equal(afterUpdate.find((item) => item.id === second.id)?.status, "discovered");

  // tmp+rename leaves no residue behind.
  const files = await fs.readdir(dir);
  assert.deepEqual(files, ["applications.json"], "no .tmp files may linger after writes");

  await fs.rm(dir, { recursive: true, force: true });
});

test("summary reports the persisted submitting retry fence", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-jobstore-summary-"));
  const store = new JobApplicationStore(path.join(dir, "applications.json"));
  await store.init();
  const item = await store.create(draft(1));
  await store.update(item.id, { status: "submitting" });

  const summary = await store.summary();
  assert.equal(summary.total, 1);
  assert.equal(summary.submitting, 1);
  assert.equal(summary.submitted, 0);
});

test("beginSubmission is an atomic compare-and-set", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-jobstore-submit-"));
  const store = new JobApplicationStore(path.join(dir, "applications.json"));
  await store.init();
  const item = await store.create(draft(1));

  const results = await Promise.allSettled([
    store.beginSubmission(item.id, "discovered"),
    store.beginSubmission(item.id, "discovered"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await store.get(item.id))?.status, "submitting");
});
