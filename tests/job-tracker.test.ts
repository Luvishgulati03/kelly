import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { MailWatchService, type MailWatchNotifier } from "../src/mailwatch/service.ts";
import { parseAppLine, reconcileSubmittedApplications, recordTrackerEvent, updateTracker, trackerSummary, trackerDigest, renderMarkdown } from "../src/mailwatch/tracker.ts";
import type { ProviderRunner } from "../src/providers/runner.ts";
import type { RunResult } from "../src/types.ts";

async function setup(): Promise<{ config: ReturnType<typeof loadConfig>; activity: ActivityLog }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-jobtracker-"));
  const config = loadConfig(rootDir);
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  return { config, activity };
}

function fakeRunner(response: string): ProviderRunner {
  return {
    run: async (): Promise<RunResult> => ({
      runId: "r1", provider: "codex", response, exitCode: 0, durationMs: 1, events: [],
    }),
  } as unknown as ProviderRunner;
}

function fakeNotifier(): { notify: MailWatchNotifier; messages: Array<{ message: string; title?: string }> } {
  const messages: Array<{ message: string; title?: string }> = [];
  const notify: MailWatchNotifier = async (message, title) => { messages.push({ message, title }); };
  return { notify, messages };
}

test("parseAppLine parses well-formed APP lines and rejects garbage", () => {
  const good = parseAppLine("APP|Acme Corp|SWE Intern|LinkedIn|applied|Aug 1|Your application was sent to Acme Corp");
  assert.deepEqual(good, {
    company: "Acme Corp", role: "SWE Intern", source: "LinkedIn", status: "applied",
    dateText: "Aug 1", subject: "Your application was sent to Acme Corp",
  });
  assert.equal(parseAppLine("NO_ALERTS"), undefined);
  assert.equal(parseAppLine(""), undefined);
  assert.equal(parseAppLine("just some prose"), undefined);
  assert.equal(parseAppLine("APP|only|four|parts"), undefined);
  // Unknown status is rejected.
  assert.equal(parseAppLine("APP|Acme|SWE|LinkedIn|ghosted|Aug 1|subject"), undefined);
  // Missing company is rejected.
  assert.equal(parseAppLine("APP||SWE|LinkedIn|applied|Aug 1|subject"), undefined);
  // A subject containing a pipe is preserved via the greedy trailing join.
  const withPipe = parseAppLine("APP|Acme|SWE|LinkedIn|applied|Aug 1|Re: Application | Acme Corp");
  assert.equal(withPipe?.subject, "Re: Application | Acme Corp");
  const actionable = parseAppLine("APP|Gemba|Engineer|direct|shortlisted|Sep 1|Next steps|ACTION=questionnaire");
  assert.equal(actionable?.subject, "Next steps");
  assert.equal(actionable?.pendingAction, "questionnaire");
});

test("updateTracker: a new application creates an entry and regenerates the markdown ledger", async () => {
  const { config } = await setup();
  const result = await updateTracker(config, [
    "APP|Acme Corp|SWE Intern|LinkedIn|applied|Aug 1|Your application was sent to Acme Corp",
  ]);
  assert.equal(result.created, 1);
  assert.equal(result.changed, 0);
  // Luvish's rule: an "applied" acknowledgement is INDEXED but never notified.
  assert.deepEqual(result.notifications, []);
  assert.equal(result.events.length, 1, "the event still reaches Engram even with no notification");

  const summary = await trackerSummary(config);
  assert.equal(summary.total, 1);
  assert.equal(summary.byStatus.applied, 1);

  const md = await fs.readFile(config.jobTrackerMarkdownPath, "utf8");
  assert.match(md, /\| Company \| Role \| Source \| Current status \| Pending action \| Applied \| Last update \|/);
  assert.match(md, /\| Acme Corp \| SWE Intern \| LinkedIn \| applied \| — \| Aug 1 \|/);
  assert.match(md, /### Acme Corp — SWE Intern/);
});

test("updateTracker: a repeated identical status line does not duplicate history or re-notify", async () => {
  const { config } = await setup();
  const line = "APP|Acme Corp|SWE Intern|LinkedIn|applied|Aug 1|Your application was sent to Acme Corp";
  const first = await updateTracker(config, [line]);
  assert.equal(first.created, 1);
  const second = await updateTracker(config, [line]);
  assert.equal(second.created, 0);
  assert.equal(second.changed, 0);
  assert.deepEqual(second.notifications, []);

  const raw = JSON.parse(await fs.readFile(config.jobTrackerPath, "utf8")) as { entries: Array<{ history: unknown[] }> };
  assert.equal(raw.entries.length, 1);
  assert.equal(raw.entries[0].history.length, 1);
});

test("recordTrackerEvent atomically records structured evidence without APP serialization", async () => {
  const { config } = await setup();
  const [acme, beta] = await Promise.all([
    recordTrackerEvent(config, {
      company: "Acme|Labs", role: "SWE|Platform", source: "generic", status: "applied",
      dateText: "2026-09-10T10:00:00.000Z", subject: "Henry browser confirmation | Application submitted",
    }),
    recordTrackerEvent(config, {
      company: "Beta", role: "PM", source: "generic", status: "applied",
      dateText: "2026-09-10T10:01:00.000Z", subject: "Henry browser confirmation: received",
    }),
  ]);
  assert.equal(acme.created, 1);
  assert.equal(beta.created, 1);
  const raw = JSON.parse(await fs.readFile(config.jobTrackerPath, "utf8")) as {
    entries: Array<{ company: string; role: string; history: Array<{ subject: string }> }>;
  };
  assert.equal(raw.entries.length, 2, "concurrent structured writes must not clobber one another");
  assert.ok(raw.entries.some((entry) => entry.company === "Acme|Labs" && entry.role === "SWE|Platform"));
  assert.ok(raw.entries.some((entry) => entry.history[0]?.subject.includes("| Application submitted")));
});

test("structured draft IDs keep repeat company-role applications separate while email fallback still dedupes", async () => {
  const { config } = await setup();
  for (const applicationId of ["draft-one", "draft-two"]) {
    await recordTrackerEvent(config, {
      applicationId, company: "Acme", role: "Engineer", source: "generic", status: "applied",
      dateText: "2026-09-10T10:00:00.000Z", subject: `Confirmed ${applicationId}`,
    });
  }
  const email = "APP|Beta|PM|direct|applied|Sep 10|Application received";
  await updateTracker(config, [email]);
  await updateTracker(config, [email]);

  const raw = JSON.parse(await fs.readFile(config.jobTrackerPath, "utf8")) as {
    entries: Array<{ key: string; applicationId?: string; company: string; history: unknown[] }>;
  };
  assert.equal(raw.entries.filter((entry) => entry.company === "Acme").length, 2);
  assert.deepEqual(raw.entries.filter((entry) => entry.company === "Acme").map((entry) => entry.applicationId).sort(), ["draft-one", "draft-two"]);
  assert.equal(raw.entries.filter((entry) => entry.company === "Beta").length, 1);
  assert.equal(raw.entries.find((entry) => entry.company === "Beta")?.history.length, 1);
});

test("email status merges into one unambiguous browser record", async () => {
  const { config } = await setup();
  await recordTrackerEvent(config, {
    applicationId: "draft-one", company: "Acme", role: "Engineer", source: "generic", status: "applied",
    dateText: "Sep 10", subject: "Browser confirmed",
  });
  await updateTracker(config, ["APP|Acme|Engineer|direct|interview|Sep 12|Interview invitation"]);

  const raw = JSON.parse(await fs.readFile(config.jobTrackerPath, "utf8")) as {
    entries: Array<{ applicationId?: string; status: string; history: Array<{ status: string }> }>;
  };
  assert.equal(raw.entries.length, 1);
  assert.equal(raw.entries[0]?.applicationId, "draft-one");
  assert.equal(raw.entries[0]?.status, "interview");
  assert.deepEqual(raw.entries[0]?.history.map((item) => item.status), ["applied", "interview"]);
});

test("reconciliation upgrades one matching legacy email record instead of duplicating it", async () => {
  const { config } = await setup();
  await updateTracker(config, ["APP|Acme|Engineer|direct|applied|Sep 10|Application received"]);
  await fs.writeFile(config.jobApplicationsPath, JSON.stringify([{
    id: "draft-one", status: "submitted", submittedAt: "2026-09-10T10:00:00.000Z",
    posting: { company: "Acme", title: "Engineer", source: "generic" },
  }]));

  const reconciliation = await reconcileSubmittedApplications(config);
  const raw = JSON.parse(await fs.readFile(config.jobTrackerPath, "utf8")) as {
    entries: Array<{ key: string; applicationId?: string; history: unknown[] }>;
  };
  assert.equal(reconciliation.created, 0);
  assert.equal(raw.entries.length, 1);
  assert.equal(raw.entries[0]?.applicationId, "draft-one");
  assert.equal(raw.entries[0]?.key, "application:draft-one");
  assert.equal(raw.entries[0]?.history.length, 1);
});

test("concurrent writers quarantine one stale lock without deleting a fresh replacement", async () => {
  const { config } = await setup();
  const lockPath = `${config.jobTrackerPath}.lock`;
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(lockPath, `999999999:stale-owner`);

  await Promise.all([
    recordTrackerEvent(config, {
      applicationId: "draft-a", company: "Acme", role: "Engineer", source: "generic", status: "applied",
      dateText: "Sep 10", subject: "Confirmed A",
    }),
    recordTrackerEvent(config, {
      applicationId: "draft-b", company: "Beta", role: "Engineer", source: "generic", status: "applied",
      dateText: "Sep 10", subject: "Confirmed B",
    }),
  ]);

  const raw = JSON.parse(await fs.readFile(config.jobTrackerPath, "utf8")) as { entries: Array<{ applicationId?: string }> };
  assert.deepEqual(raw.entries.map((entry) => entry.applicationId).sort(), ["draft-a", "draft-b"]);
  await assert.rejects(fs.access(lockPath));
  await assert.rejects(fs.access(`${lockPath}.stale-break`));
});

test("submitted application records deterministically reconcile by draft ID without a provider", async () => {
  const { config } = await setup();
  const submitted = ["draft-one", "draft-two"].map((id) => ({
    id, status: "submitted", submittedAt: "2026-09-10T10:00:00.000Z",
    posting: { company: "Acme", title: "Engineer", source: "generic" },
  }));
  await fs.writeFile(config.jobApplicationsPath, JSON.stringify(submitted));

  const first = await reconcileSubmittedApplications(config);
  const second = await reconcileSubmittedApplications(config);
  assert.equal(first.submittedRecords, 2);
  assert.equal(first.created, 2);
  assert.equal(second.created, 0);
  assert.equal(second.changed, 0);
  assert.equal((await trackerSummary(config)).total, 2);
});

test("updateTracker: a status transition appends history and notifies", async () => {
  const { config } = await setup();
  await updateTracker(config, ["APP|Acme Corp|SWE Intern|LinkedIn|applied|Aug 1|Your application was sent to Acme Corp"]);
  const transition = await updateTracker(config, ["APP|Acme Corp|SWE Intern|LinkedIn|shortlisted|Aug 5|You've been shortlisted!"]);
  assert.equal(transition.created, 0);
  assert.equal(transition.changed, 1);
  assert.deepEqual(transition.notifications, ["📋 Application update: Acme Corp SWE Intern → shortlisted"]);

  const raw = JSON.parse(await fs.readFile(config.jobTrackerPath, "utf8")) as {
    entries: Array<{ status: string; appliedAt: string; history: Array<{ status: string }> }>;
  };
  assert.equal(raw.entries.length, 1);
  assert.equal(raw.entries[0].status, "shortlisted");
  assert.equal(raw.entries[0].appliedAt, "Aug 1", "appliedAt stays pinned to the first (applied) history entry");
  assert.deepEqual(raw.entries[0].history.map((h) => h.status), ["applied", "shortlisted"]);
});

test("updateTracker: rejections are indexed silently — only responses other than rejected notify", async () => {
  const { config } = await setup();
  // Two applications, both acknowledged: neither acknowledgement notifies.
  const acked = await updateTracker(config, [
    "APP|Acme Corp|SWE Intern|LinkedIn|applied|Aug 1|Your application was sent to Acme Corp",
    "APP|Beta Inc|AI Engineer|Naukri|applied|Aug 1|Thanks for applying",
  ]);
  assert.deepEqual(acked.notifications, []);

  // Acme rejects (silent, but recorded), Beta invites an assessment (notifies).
  const outcome = await updateTracker(config, [
    "APP|Acme Corp|SWE Intern|LinkedIn|rejected|Aug 6|We're moving forward with other candidates",
    "APP|Beta Inc|AI Engineer|Naukri|assessment|Aug 6|Complete your take-home",
  ]);
  assert.deepEqual(outcome.notifications, ["📋 Application update: Beta Inc AI Engineer → assessment"]);
  assert.equal(outcome.changed, 2, "both transitions are still recorded — the filter is on notifications only");
  assert.equal(outcome.events.length, 2, "both still reach Engram");

  // The index is complete regardless of what was notified.
  const summary = await trackerSummary(config);
  assert.equal(summary.byStatus.rejected, 1);
  assert.equal(summary.byStatus.assessment, 1);
  const md = await fs.readFile(config.jobTrackerMarkdownPath, "utf8");
  assert.match(md, /\| Acme Corp \| SWE Intern \| LinkedIn \| rejected \|/);
});

test("updateTracker: malformed APP lines are skipped without throwing", async () => {
  const { config } = await setup();
  const result = await updateTracker(config, [
    "APP|Acme Corp|SWE Intern|LinkedIn|applied|Aug 1|Your application was sent to Acme Corp",
    "APP|missing|fields",
    "APP|Beta Inc|PM|Naukri|not-a-real-status|Aug 2|subject",
    "just some prose",
    "",
  ]);
  assert.equal(result.created, 1);
  assert.equal(result.changed, 0);
  const summary = await trackerSummary(config);
  assert.equal(summary.total, 1);
});

test("updateTracker: two different companies each get their own entry, sorted last-update desc in the markdown", async () => {
  const { config } = await setup();
  await updateTracker(config, ["APP|Acme Corp|SWE Intern|LinkedIn|applied|Aug 1|subject A"]);
  // lastUpdate has millisecond resolution — force Beta onto a LATER stamp so the
  // desc sort is deterministic (same-ms ties fall back to insertion order).
  await new Promise((resolve) => setTimeout(resolve, 2));
  await updateTracker(config, ["APP|Beta Inc|PM|Naukri|applied|Aug 2|subject B"]);
  const md = await fs.readFile(config.jobTrackerMarkdownPath, "utf8");
  const acmeIndex = md.indexOf("| Acme Corp |");
  const betaIndex = md.indexOf("| Beta Inc |");
  assert.ok(betaIndex >= 0 && acmeIndex >= 0);
  assert.ok(betaIndex < acmeIndex, "the more recently updated company (Beta Inc) sorts first");
});

test("renderMarkdown produces a well-formed table and history section, and a friendly empty state", () => {
  const empty = renderMarkdown({ entries: [] });
  assert.match(empty, /No applications tracked yet/);

  const md = renderMarkdown({
    entries: [{
      key: "acme corp::swe intern", company: "Acme Corp", role: "SWE Intern", source: "LinkedIn",
      status: "interview", appliedAt: "Aug 1", lastUpdate: "Aug 10",
      history: [
        { status: "applied", dateText: "Aug 1", subject: "Applied", recordedAt: "2026-08-01T00:00:00.000Z" },
        { status: "interview", dateText: "Aug 10", subject: "Interview!", recordedAt: "2026-08-10T00:00:00.000Z" },
      ],
    }],
  });
  const tableLines = md.split("\n").filter((l) => l.startsWith("|"));
  assert.equal(tableLines.length, 3, "header + separator + one data row");
  assert.match(md, /- Aug 1 — \*\*applied\*\* — "Applied"/);
  assert.match(md, /- Aug 10 — \*\*interview\*\* — "Interview!"/);
});

test("updateTracker: status never regresses — a lower status joins history silently; terminal outcomes always land", async () => {
  const { config } = await setup();
  await updateTracker(config, ["APP|Acme Corp|SWE Intern|LinkedIn|applied|Aug 1|applied subject"]);
  await updateTracker(config, ["APP|Acme Corp|SWE Intern|LinkedIn|interview|Aug 10|interview subject"]);

  const regression = await updateTracker(config, ["APP|Acme Corp|SWE Intern|LinkedIn|viewed|Aug 3|late viewed email"]);
  assert.equal(regression.changed, 0);
  assert.deepEqual(regression.notifications, [], "a regression must not notify");
  const raw = JSON.parse(await fs.readFile(config.jobTrackerPath, "utf8")) as {
    entries: Array<{ status: string; history: Array<{ status: string }> }>;
  };
  assert.equal(raw.entries[0].status, "interview", "the headline status must never move backward");
  assert.deepEqual(raw.entries[0].history.map((h) => h.status), ["applied", "interview", "viewed"], "the late email still joins the audit trail");

  // Terminal outcomes are always accepted — even offer → rejected (rescinded/declined).
  await updateTracker(config, ["APP|Acme Corp|SWE Intern|LinkedIn|offer|Aug 20|offer letter"]);
  const rescinded = await updateTracker(config, ["APP|Acme Corp|SWE Intern|LinkedIn|rejected|Aug 25|offer rescinded"]);
  assert.equal(rescinded.changed, 1);
  const rawAfter = JSON.parse(await fs.readFile(config.jobTrackerPath, "utf8")) as { entries: Array<{ status: string }> };
  assert.equal(rawAfter.entries[0].status, "rejected");
});

test("updateTracker: appliedAt only comes from an applied line — a rejection-created entry backfills it later, silently", async () => {
  const { config } = await setup();
  await updateTracker(config, ["APP|Beta Inc|PM|Naukri|rejected|Aug 5|unfortunately..."]);
  const raw = JSON.parse(await fs.readFile(config.jobTrackerPath, "utf8")) as { entries: Array<{ status: string; appliedAt: string }> };
  assert.equal(raw.entries[0].status, "rejected");
  assert.equal(raw.entries[0].appliedAt, "", "a rejection's date must not masquerade as the application date");

  const late = await updateTracker(config, ["APP|Beta Inc|PM|Naukri|applied|Jul 30|your application was sent"]);
  assert.deepEqual(late.notifications, [], "the late applied confirmation is old news");
  const rawAfter = JSON.parse(await fs.readFile(config.jobTrackerPath, "utf8")) as { entries: Array<{ status: string; appliedAt: string }> };
  assert.equal(rawAfter.entries[0].appliedAt, "Jul 30", "the applied line backfills appliedAt");
  assert.equal(rawAfter.entries[0].status, "rejected", "the backfill must not regress the status");
});

test("trackerDigest excludes backfilled history from today's counts while live events still count", async () => {
  const { config } = await setup();
  await updateTracker(config, [
    "APP|Gamma LLC|Backend Engineer|direct|applied|Jul 20|Thanks for applying",
    "APP|Gamma LLC|Backend Engineer|direct|interview|Jul 25|Interview invite",
  ], { backfill: true });
  const seeded = await trackerDigest(config);
  assert.equal(seeded.newlyIndexed, 0, "backfilled events are not newly indexed digest activity");
  assert.equal(seeded.indexedUpdates, 0);
  assert.equal(seeded.indexedJobRecords, 1);

  await updateTracker(config, ["APP|Delta Co|PM|LinkedIn|applied|today|Application sent"]);
  const live = await trackerDigest(config);
  assert.equal(live.newlyIndexed, 1, "a live confirmation newly indexed on this local day counts");
  assert.equal(live.indexedUpdates, 0);
  assert.match(live.line, /newly indexed: 1 confirmation record/);
  assert.match(live.line, /2 indexed job records/);
  assert.doesNotMatch(live.line, /today:|tracked \d+|\d+ applications?/i, "wording must not infer event dates or real application totals");
});

test("MailWatchService.check(): APP lines update the tracker and notify only on new/changed status", async () => {
  const { config, activity } = await setup();
  const response = [
    "ALERT|msg-1|recruiter@acme.com|You've been shortlisted|Shortlisting notice",
    "APP|Acme Corp|SWE Intern|LinkedIn|applied|Aug 1|Your application was sent to Acme Corp",
    "APP|Acme Corp|SWE Intern|LinkedIn|shortlisted|Aug 5|You've been shortlisted!",
  ].join("\n");
  const { notify, messages } = fakeNotifier();
  const service = new MailWatchService(config, activity, fakeRunner(response), notify);
  await service.check();

  const trackerMessages = messages.filter((m) => m.title === "Henry — job tracker");
  assert.equal(trackerMessages.length, 1, "the applied acknowledgement stays silent; only the shortlisting notifies");
  assert.equal(trackerMessages[0].message, "📋 Application update: Acme Corp SWE Intern → shortlisted");

  const summary = await trackerSummary(config);
  assert.equal(summary.total, 1);
  assert.equal(summary.byStatus.shortlisted, 1);

  // A later check() re-scanning a window where the same "shortlisted" email is still visible
  // (its current, unchanged status) must not re-notify the tracker.
  const repeatService = new MailWatchService(
    config, activity,
    fakeRunner("APP|Acme Corp|SWE Intern|LinkedIn|shortlisted|Aug 5|You've been shortlisted!"),
    notify,
  );
  await repeatService.check();
  const trackerMessagesAfter = messages.filter((m) => m.title === "Henry — job tracker");
  assert.equal(trackerMessagesAfter.length, 1, "the repeat check must not duplicate tracker notifications");
});

test("MailWatchService.backfill(): seeds the tracker from a single read-only provider call without touching mailwatch state", async () => {
  const { config, activity } = await setup();
  const response = [
    "APP|Gamma LLC|Backend Engineer|direct|applied|Jul 20|Thanks for applying to Gamma LLC",
    "APP|Gamma LLC|Backend Engineer|direct|rejected|Jul 28|Update on your application",
  ].join("\n");
  const { notify, messages } = fakeNotifier();
  // Establish real, persisted mailwatch state via a normal check() first, so the "unchanged by
  // backfill" comparison below is against a concrete written value rather than two independently
  // computed first-run defaults (which would differ by measurement noise alone).
  await new MailWatchService(config, activity, fakeRunner("NO_ALERTS")).check();
  const beforeStatus = await new MailWatchService(config, activity, fakeRunner("NO_ALERTS")).status();

  const service = new MailWatchService(config, activity, fakeRunner(response), notify);
  const result = await service.backfill(21);
  assert.equal(result.appLines, 2);
  assert.equal(result.created, 1);
  assert.equal(result.changed, 1);
  // ONE summary ping with counts — never a per-event blast for weeks-old history.
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /Backfill: seeded 1 application, 1 status update from the last 21 days/);
  assert.deepEqual(result.notifications, [messages[0].message]);

  const afterStatus = await service.status();
  assert.equal(afterStatus.lastCheckIso, beforeStatus.lastCheckIso, "backfill must not touch check()'s lastCheckIso");
  assert.equal(afterStatus.seenCount, beforeStatus.seenCount, "backfill must not touch check()'s seenIds");

  const summary = await trackerSummary(config);
  assert.equal(summary.total, 1);
  assert.equal(summary.byStatus.rejected, 1);
});

test("MailWatchService.backfill(): requires full-body reads and persists body-only pending actions", async () => {
  const { config, activity } = await setup();
  let prompt = "";
  const response = [
    "APP|Gemba|AI Engineer|direct|shortlisted|Sep 1|Application update|ACTION=questionnaire",
    "APP|Swiggy|Software Engineer|direct|shortlisted|Sep 2|Your application|ACTION=additional_details",
    "APP|Albertsons|Software Engineer|direct|shortlisted|Sep 3|Application status|ACTION=screening_questions",
    "APP|IRIS|AI Product Manager|direct|shortlisted|Sep 4|Following up|ACTION=referral",
  ].join("\n");
  const runner = {
    run: async (value: string): Promise<RunResult> => {
      prompt = value;
      return { runId: "r", provider: "codex", response, exitCode: 0, durationMs: 1, events: [] };
    },
  } as unknown as ProviderRunner;
  const result = await new MailWatchService(config, activity, runner).backfill(30);
  assert.equal(result.created, 4);
  assert.match(prompt, /fetch and read the full email body/i);
  assert.match(prompt, /Gemba-style questionnaires/);
  assert.match(prompt, /Albertsons/);
  assert.match(prompt, /Swiggy/);
  assert.match(prompt, /IRIS/);

  const raw = JSON.parse(await fs.readFile(config.jobTrackerPath, "utf8")) as {
    entries: Array<{ company: string; pendingAction?: string; history: Array<{ pendingAction?: string }> }>;
  };
  assert.deepEqual(Object.fromEntries(raw.entries.map((entry) => [entry.company, entry.pendingAction])), {
    Gemba: "questionnaire", Swiggy: "additional_details",
    Albertsons: "screening_questions", IRIS: "referral",
  });
  assert.ok(raw.entries.every((entry) => entry.history[0]?.pendingAction === entry.pendingAction));
  const md = await fs.readFile(config.jobTrackerMarkdownPath, "utf8");
  assert.match(md, /pending \*\*questionnaire\*\*/);
  assert.match(md, /pending \*\*additional details\*\*/);
  assert.match(md, /pending \*\*screening questions\*\*/);
  assert.match(md, /pending \*\*referral\*\*/);
});

test("updateTracker: a new pending action at the same status is surfaced once", async () => {
  const { config } = await setup();
  await updateTracker(config, ["APP|Gemba|AI Engineer|direct|shortlisted|Sep 1|You are shortlisted"]);
  const actionable = await updateTracker(config, [
    "APP|Gemba|AI Engineer|direct|shortlisted|Sep 5|Please complete this form|ACTION=questionnaire",
  ]);
  assert.equal(actionable.changed, 1);
  assert.deepEqual(actionable.notifications, ["📋 Application action needed: Gemba AI Engineer → questionnaire"]);
  assert.equal(actionable.events[0]?.pendingAction, "questionnaire");

  const repeated = await updateTracker(config, [
    "APP|Gemba|AI Engineer|direct|shortlisted|Sep 5|Please complete this form|ACTION=questionnaire",
  ]);
  assert.equal(repeated.changed, 0);
  assert.deepEqual(repeated.notifications, []);
});
