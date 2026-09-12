import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { JobApplicationService } from "../src/jobs/service.ts";
import { applicationContentHash } from "../src/jobs/team.ts";
import { FillIncompleteError, SubmissionOutcomeUnknownError, type JobBrowser } from "../src/jobs/browser.ts";
import { trackerSummary } from "../src/mailwatch/tracker.ts";
import type { StructuredTrackerEvent, TrackerUpdateResult } from "../src/mailwatch/tracker.ts";
import type { HenryConfig } from "../src/config.ts";
import type { ActivityLog } from "../src/activity.ts";
import type { ApprovalStore } from "../src/approval/store.ts";
import type { HenryMemory } from "../src/memory/engram.ts";
import type { ProviderRunner } from "../src/providers/runner.ts";
import type { ApprovalItem } from "../src/types.ts";

type TrackerRecorder = (config: HenryConfig, event: StructuredTrackerEvent) => Promise<TrackerUpdateResult>;

async function fixture(submit: JobBrowser["submit"], trackerRecorder?: TrackerRecorder) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "henry-job-orchestration-"));
  const config = loadConfig(root);
  const browser = {
    inspect: async () => { throw new Error("not used"); },
    fill: async () => { throw new Error("not used"); },
    submit,
  } as JobBrowser;
  const activities: Array<{ type: string; message: string; metadata?: Record<string, unknown> }> = [];
  const service = new JobApplicationService(
    config,
    { record: async (type: string, message: string, metadata?: Record<string, unknown>) => { activities.push({ type, message, metadata }); } } as unknown as ActivityLog,
    {} as ApprovalStore,
    { remember: async () => "memory-id" } as unknown as HenryMemory,
    {} as ProviderRunner,
    browser,
    undefined,
    trackerRecorder,
  );
  await service.init();
  const posting = {
    id: "posting-1", url: "https://jobs.example.com/engineer", source: "generic" as const,
    title: "Platform Engineer", company: "Acme", description: "Build systems",
    descriptionHash: "description-hash", questions: [], discoveredAt: "2026-09-10T09:00:00.000Z",
  };
  const coverLetter = "Evidence-backed letter";
  const reviewedContentHash = applicationContentHash({
    url: posting.url, posting: posting.descriptionHash, answers: {}, coverLetter, resume: undefined, sha256: undefined,
  });
  const draft = await service.store.create({
    posting, coverLetter, answers: {}, rationale: {}, missingFacts: [], memoryIds: [],
    status: "ready-for-review", review: { accepted: true, issues: [], sourceHash: "source", draftHash: "draft" }, reviewedContentHash,
  });
  const approval = {
    id: "approval-1", createdAt: "2026-09-10T09:30:00.000Z", updatedAt: "2026-09-10T09:31:00.000Z",
    kind: "job.application", status: "executing", title: "Apply", body: "Approved application",
    payload: { applicationId: draft.id, reviewedContentHash, descriptionHash: posting.descriptionHash },
  } satisfies ApprovalItem;
  return { config, service, approval, activities };
}

test("confirmed Henry browser submission records structured evidence in the canonical tracker", async () => {
  const submittedAt = "2026-09-10T10:00:00.000Z";
  const { config, service, approval } = await fixture(async () => ({
    url: "https://jobs.example.com/confirmation", submittedAt, confirmationText: "Application | submitted successfully",
  }));
  await service.submitApproved(approval);

  const state = JSON.parse(await fs.readFile(config.jobTrackerPath, "utf8")) as {
    entries: Array<{ applicationId?: string; company: string; role: string; status: string; appliedAt: string; history: Array<{ subject: string }> }>;
  };
  assert.equal(state.entries.length, 1);
  assert.deepEqual(state.entries[0] && {
    company: state.entries[0].company, role: state.entries[0].role,
    status: state.entries[0].status, appliedAt: state.entries[0].appliedAt,
  }, { company: "Acme", role: "Platform Engineer", status: "applied", appliedAt: submittedAt });
  assert.equal(state.entries[0]?.applicationId, approval.payload.applicationId);
  assert.match(state.entries[0]?.history[0]?.subject ?? "", /Application \| submitted successfully/);
});

test("unconfirmed browser submission never enters the canonical tracker", async () => {
  const { config, service, approval } = await fixture(async () => { throw new SubmissionOutcomeUnknownError(); });
  await assert.rejects(service.submitApproved(approval), SubmissionOutcomeUnknownError);
  assert.equal((await trackerSummary(config)).total, 0);
  assert.equal((await service.store.get(String(approval.payload.applicationId)))?.status, "submission-uncertain");
});

test("tracker reconciliation failure after confirmed submit is logged but cannot turn submission into a retryable failure", async () => {
  const trackerRecorder: TrackerRecorder = async () => { throw new Error("tracker disk unavailable"); };
  const { config, service, approval, activities } = await fixture(async () => ({
    url: "https://jobs.example.com/confirmation",
    submittedAt: "2026-09-10T10:00:00.000Z",
    confirmationText: "Application submitted successfully",
  }), trackerRecorder);

  assert.equal(await service.submitApproved(approval), "https://jobs.example.com/confirmation");
  const stored = await service.store.get(String(approval.payload.applicationId));
  assert.equal(stored?.status, "submitted");
  assert.equal((await trackerSummary(config)).total, 0);
  const reconciliation = activities.filter((event) => event.type === "job.submitted" && event.metadata?.trackerReconciliation === "failed");
  assert.equal(reconciliation.length, 1);
  assert.match(String(reconciliation[0]?.metadata?.error), /tracker disk unavailable/);
});

test("application-store failure after confirmed submit is non-fatal and tracker reconciliation still runs", async () => {
  let recordedApplicationId = "";
  const trackerRecorder: TrackerRecorder = async (_config, event) => {
    recordedApplicationId = event.applicationId ?? "";
    return { notifications: [], created: 1, changed: 0, events: [] };
  };
  const { service, approval, activities } = await fixture(async () => ({
    url: "https://jobs.example.com/confirmation",
    submittedAt: "2026-09-10T10:00:00.000Z",
    confirmationText: "Application submitted successfully",
  }), trackerRecorder);
  service.store.update = async () => { throw new Error("application store disk unavailable"); };

  assert.equal(await service.submitApproved(approval), "https://jobs.example.com/confirmation");
  assert.equal(recordedApplicationId, approval.payload.applicationId);
  assert.equal((await service.store.get(String(approval.payload.applicationId)))?.status, "submitting", "failed post-confirmation persistence leaves the retry fence in place");
  const persistence = activities.filter((event) => event.type === "job.submitted" && event.metadata?.localPersistence === "application-store");
  assert.equal(persistence.length, 1);
  assert.match(String(persistence[0]?.metadata?.error), /application store disk unavailable/);
});

test("persisted submitting status blocks every subsequent browser submit", async () => {
  let browserCalls = 0;
  const { service, approval } = await fixture(async () => {
    browserCalls += 1;
    throw new Error("must not run");
  });
  await service.store.update(String(approval.payload.applicationId), { status: "submitting" });

  await assert.rejects(service.submitApproved(approval), /already submitting|possible duplicate/i);
  assert.equal(browserCalls, 0);
});

test("the submitting compare-and-set allows only one concurrent browser submit", async () => {
  let browserCalls = 0;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const browserStarted = new Promise<void>((resolve) => { started = resolve; });
  const { service, approval } = await fixture(async () => {
    browserCalls += 1;
    started();
    await gate;
    return {
      url: "https://jobs.example.com/confirmation",
      submittedAt: "2026-09-10T10:00:00.000Z",
      confirmationText: "Application submitted successfully",
    };
  });

  const first = service.submitApproved(approval);
  await browserStarted;
  const second = service.submitApproved(approval);
  await assert.rejects(second, /status changed|possible duplicate|already submitting/i);
  release();
  assert.equal(await first, "https://jobs.example.com/confirmation");
  assert.equal(browserCalls, 1);
});

test("proven pre-click FillIncomplete failure restores the prior safe status", async () => {
  const { service, approval } = await fixture(async () => {
    throw new FillIncompleteError(["work authorization"], ["work authorization"]);
  });

  await assert.rejects(service.submitApproved(approval), FillIncompleteError);
  assert.equal((await service.store.get(String(approval.payload.applicationId)))?.status, "ready-for-review");
});

test("an otherwise unknown browser error becomes submission-uncertain", async () => {
  const { service, approval } = await fixture(async () => { throw new Error("browser transport vanished"); });

  await assert.rejects(service.submitApproved(approval), /browser transport vanished/);
  assert.equal((await service.store.get(String(approval.payload.applicationId)))?.status, "submission-uncertain");
});
