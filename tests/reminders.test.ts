import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import {
  ReminderService,
  parseAt,
  parseIn,
  nextCronFireAt,
  REMINDER_OVERDUE_GRACE_MS,
  PROMPT_NO_NOTIFICATION,
  type ReminderNotifier,
  type PromptRunner,
  type ExecuteApprovalFn,
} from "../src/reminders/service.ts";
import { startReminderTicker, __resetReminderTickerForTests } from "../src/reminders/ticker.ts";

async function setup(): Promise<{ config: ReturnType<typeof loadConfig>; activity: ActivityLog }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-reminders-"));
  const config = loadConfig(rootDir);
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  return { config, activity };
}

function fakeNotifier(): { notify: ReminderNotifier; messages: string[] } {
  const messages: string[] = [];
  const notify: ReminderNotifier = async (message) => { messages.push(message); };
  return { notify, messages };
}

test("parseAt parses 'YYYY-MM-DD HH:mm' as local time", () => {
  const date = parseAt("2026-08-10 14:30");
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 7);
  assert.equal(date.getDate(), 10);
  assert.equal(date.getHours(), 14);
  assert.equal(date.getMinutes(), 30);
});

test("parseAt also accepts a 'T' separator", () => {
  const date = parseAt("2026-08-10T14:30");
  assert.equal(date.getHours(), 14);
});

test("parseAt rejects malformed input", () => {
  assert.throws(() => parseAt("not-a-date"), /Invalid --at value/);
  assert.throws(() => parseAt("2026/08/10 14:30"), /Invalid --at value/);
});

test("parseIn parses single-unit durations", () => {
  const from = new Date("2026-08-06T10:00:00");
  assert.equal(parseIn("30m", from).getTime(), from.getTime() + 30 * 60_000);
  assert.equal(parseIn("2h", from).getTime(), from.getTime() + 2 * 3_600_000);
  assert.equal(parseIn("1d", from).getTime(), from.getTime() + 86_400_000);
});

test("parseIn parses combined durations like '1h30m'", () => {
  const from = new Date("2026-08-06T10:00:00");
  assert.equal(parseIn("1h30m", from).getTime(), from.getTime() + 90 * 60_000);
});

test("parseIn rejects unparseable durations", () => {
  assert.throws(() => parseIn("soon"), /Invalid --in duration/);
});

test("create() persists a pending reminder to disk", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const dueAt = new Date(Date.now() + 3_600_000);

  const reminder = await service.create("Call the recruiter", dueAt);

  assert.equal(reminder.status, "pending");
  assert.equal(reminder.text, "Call the recruiter");
  const onDisk = JSON.parse(await fs.readFile(config.remindersPath, "utf8"));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].id, reminder.id);
});

test("list() supports filtering by status", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const a = await service.create("A", new Date(Date.now() + 60_000));
  await service.create("B", new Date(Date.now() + 120_000));
  await service.cancel(a.id);

  const pending = await service.list("pending");
  const cancelled = await service.list("cancelled");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].text, "B");
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].text, "A");
});

test("cancel() only allows cancelling pending reminders", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const reminder = await service.create("A", new Date(Date.now() + 60_000));
  await service.cancel(reminder.id);
  await assert.rejects(() => service.cancel(reminder.id), /only pending reminders can be cancelled/);
});

test("cancel() throws for an unknown id", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  await assert.rejects(() => service.cancel("nope"), /Reminder not found/);
});

test("fireDue() fires only pending reminders that are due, notifies, and updates status", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const now = new Date("2026-08-06T12:00:00Z");
  const due = await service.create("Due now", new Date(now.getTime() - 1000));
  const notYetDue = await service.create("Not yet", new Date(now.getTime() + 3_600_000));

  const { notify, messages } = fakeNotifier();
  const fired = await service.fireDue(notify, now);

  assert.equal(fired.length, 1);
  assert.equal(fired[0].id, due.id);
  assert.equal(fired[0].status, "fired");
  assert.deepEqual(messages, ["Due now"]);

  assert.equal((await service.get(due.id))?.status, "fired");
  assert.equal((await service.get(notYetDue.id))?.status, "pending");

  const events = await activity.list(10);
  assert.ok(events.some((event) => event.kind === "workflow.completed" && event.metadata?.reminder === true && event.metadata?.id === due.id));
});

test("fireDue() is fire-once: a second call does not re-fire an already-fired reminder", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const now = new Date("2026-08-06T12:00:00Z");
  await service.create("Due now", new Date(now.getTime() - 1000));

  const { notify, messages } = fakeNotifier();
  await service.fireDue(notify, now);
  const secondFired = await service.fireDue(notify, new Date(now.getTime() + 60_000));

  assert.equal(secondFired.length, 0);
  assert.equal(messages.length, 1);
});

test("fireDue() prefixes '(overdue)' when firing well past the due time (daemon was down)", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const dueAt = new Date("2026-08-06T09:00:00Z");
  const reminder = await service.create("Ping recruiter", dueAt);

  const wellPastDue = new Date(dueAt.getTime() + REMINDER_OVERDUE_GRACE_MS + 60_000);
  const { notify, messages } = fakeNotifier();
  const fired = await service.fireDue(notify, wellPastDue);

  assert.equal(fired.length, 1);
  assert.match(messages[0], /^\(overdue\) Ping recruiter$/);
  const events = await activity.list(10);
  const event = events.find((item) => item.metadata?.id === reminder.id);
  assert.equal(event?.metadata?.overdue, true);
});

test("fireDue() does not prefix '(overdue)' when firing within the normal poll grace window", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const dueAt = new Date("2026-08-06T09:00:00Z");
  await service.create("Ping recruiter", dueAt);

  const withinGrace = new Date(dueAt.getTime() + 30_000);
  const { notify, messages } = fakeNotifier();
  await service.fireDue(notify, withinGrace);

  assert.equal(messages[0], "Ping recruiter");
});

// --- Recurring jobs (cron) ---------------------------------------------------------------

test("createRecurring() computes nextFireAt via croner and stores it alongside dueAt", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const now = new Date(2026, 7, 6, 12, 3, 0); // local: Thu Aug 6 2026, 12:03
  const expectedNext = nextCronFireAt("*/5 * * * *", now);

  const reminder = await service.createRecurring("Stretch break", "*/5 * * * *", "message", now);

  assert.equal(reminder.cron, "*/5 * * * *");
  assert.equal(reminder.kind, "message");
  assert.equal(reminder.status, "pending");
  assert.equal(reminder.nextFireAt, expectedNext.toISOString());
  assert.equal(reminder.dueAt, expectedNext.toISOString());
});

test("fireDue() re-arms a recurring reminder to its next occurrence instead of marking it fired", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const now = new Date(2026, 7, 6, 12, 3, 0);
  const reminder = await service.createRecurring("Stretch break", "*/5 * * * *", "message", now);
  const firstFire = new Date(reminder.dueAt); // 12:05
  const expectedSecondFire = nextCronFireAt("*/5 * * * *", firstFire); // 12:10

  const { notify, messages } = fakeNotifier();
  const fired = await service.fireDue(notify, firstFire);

  assert.equal(fired.length, 1);
  assert.equal(fired[0].status, "pending"); // never "fired" — recurring jobs re-arm
  assert.deepEqual(messages, ["Stretch break"]);
  assert.equal(fired[0].dueAt, expectedSecondFire.toISOString());
  assert.equal(fired[0].nextFireAt, expectedSecondFire.toISOString());

  // due() no longer matches at the old fire time...
  assert.equal((await service.due(firstFire)).length, 0);
  // ...but does at the new, re-armed fire time.
  assert.equal((await service.due(expectedSecondFire)).length, 1);

  const events = await activity.list(10);
  assert.ok(events.some((event) => event.metadata?.id === reminder.id && event.metadata?.recurring === true));
});

test("fireDue() re-fires a recurring reminder across multiple occurrences without it ever going 'done'", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const now = new Date(2026, 7, 6, 12, 3, 0);
  const reminder = await service.createRecurring("Tick", "*/5 * * * *", "message", now);

  const { notify, messages } = fakeNotifier();
  let cursor = new Date(reminder.dueAt);
  for (let i = 0; i < 3; i++) {
    const fired = await service.fireDue(notify, cursor);
    assert.equal(fired.length, 1, `expected a fire at iteration ${i}`);
    assert.equal(fired[0].status, "pending");
    cursor = new Date(fired[0].dueAt);
  }
  assert.equal(messages.length, 3);
  assert.deepEqual(messages, ["Tick", "Tick", "Tick"]);
});

// --- Prompt jobs ---------------------------------------------------------------------------

function fakePromptRunner(response: string): { run: PromptRunner; prompts: string[] } {
  const prompts: string[] = [];
  const run: PromptRunner = async (prompt) => { prompts.push(prompt); return response; };
  return { run, prompts };
}

test("fireDue() runs prompt reminders through the injected PromptRunner and delivers the RESPONSE, not the prompt", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const now = new Date("2026-08-06T12:00:00Z");
  const reminder = await service.create(
    "wish Luvish good morning with one useful thing from memory",
    new Date(now.getTime() - 1000),
    "prompt",
  );

  const { notify, messages } = fakeNotifier();
  const { run, prompts } = fakePromptRunner("Morning, Luvish! Quick tip: batch your standups.");
  const fired = await service.fireDue(notify, now, run);

  assert.equal(fired.length, 1);
  assert.equal(fired[0].status, "fired"); // one-shot prompt job still fires once
  assert.deepEqual(prompts, ["wish Luvish good morning with one useful thing from memory"]);
  assert.deepEqual(messages, ["Morning, Luvish! Quick tip: batch your standups."]);

  const events = await activity.list(10);
  const event = events.find((item) => item.metadata?.id === reminder.id);
  assert.equal(event?.metadata?.kind, "prompt");
  assert.equal(event?.metadata?.message, "Morning, Luvish! Quick tip: batch your standups.");
});

test("fireDue() supports recurring prompt jobs: re-arms and re-runs the prompt on each occurrence", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const now = new Date(2026, 7, 6, 7, 28, 0);
  const reminder = await service.createRecurring(
    "wish Luvish good morning with one useful thing from memory",
    "30 7 * * *",
    "prompt",
    now,
  );

  const { notify, messages } = fakeNotifier();
  const { run, prompts } = fakePromptRunner("Good morning! Here's a tip.");
  const fired = await service.fireDue(notify, new Date(reminder.dueAt), run);

  assert.equal(fired.length, 1);
  assert.equal(fired[0].status, "pending");
  assert.equal(fired[0].kind, "prompt");
  assert.deepEqual(prompts, ["wish Luvish good morning with one useful thing from memory"]);
  assert.deepEqual(messages, ["Good morning! Here's a tip."]);
});

test("fireDue() suppresses the prompt no-notification sentinel while advancing the job", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const now = new Date("2026-08-06T12:00:00Z");
  const reminder = await service.createRecurring("check for new job emails", "*/15 * * * *", "prompt", now);

  const { notify, messages } = fakeNotifier();
  const { run } = fakePromptRunner(PROMPT_NO_NOTIFICATION);
  const fired = await service.fireDue(notify, new Date(reminder.dueAt), run);

  assert.equal(fired.length, 1);
  assert.equal(fired[0].status, "pending");
  assert.deepEqual(messages, []);
  const events = await activity.list(10);
  const event = events.find((item) => item.metadata?.id === reminder.id);
  assert.equal(event?.metadata?.notified, false);
});

test("fireDue() falls back to a placeholder when a prompt reminder fires with no PromptRunner configured", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const now = new Date("2026-08-06T12:00:00Z");
  await service.create("say hi", new Date(now.getTime() - 1000), "prompt");

  const { notify, messages } = fakeNotifier();
  await service.fireDue(notify, now); // no runPrompt argument

  assert.match(messages[0], /no prompt runner configured/);
});

test("fireDue() reports a failure message when the PromptRunner throws, and still advances the reminder", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const now = new Date("2026-08-06T12:00:00Z");
  const reminder = await service.create("say hi", new Date(now.getTime() - 1000), "prompt");

  const { notify, messages } = fakeNotifier();
  const failing: PromptRunner = async () => { throw new Error("provider unreachable"); };
  const fired = await service.fireDue(notify, now, failing);

  assert.equal(fired.length, 1);
  assert.equal(fired[0].status, "fired");
  assert.match(messages[0], /prompt reminder failed: provider unreachable/);
  assert.equal((await service.get(reminder.id))?.status, "fired");
});

// --- cancel() stops recurring jobs ----------------------------------------------------------

test("cancel() stops a recurring reminder from ever firing again", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const now = new Date(2026, 7, 6, 12, 3, 0);
  const reminder = await service.createRecurring("Stretch break", "*/5 * * * *", "message", now);
  const firstFire = new Date(reminder.dueAt);

  await service.cancel(reminder.id);

  const { notify, messages } = fakeNotifier();
  const fired = await service.fireDue(notify, firstFire);

  assert.equal(fired.length, 0);
  assert.equal(messages.length, 0);
  assert.equal((await service.get(reminder.id))?.status, "cancelled");
});

// --- approval.execute jobs (scheduled sends of already-approved actions) --------------------

test("createApprovalExecute() stores the approvalId and a default title", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);

  const reminder = await service.createApprovalExecute("appr-123", new Date(Date.now() + 60_000));

  assert.equal(reminder.kind, "approval.execute");
  assert.equal(reminder.approvalId, "appr-123");
  assert.equal(reminder.text, "approval appr-123");
  assert.equal(reminder.status, "pending");
});

test("fireDue() executes an approved approval.execute reminder and notifies success", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const now = new Date("2026-08-06T12:00:00Z");
  const reminder = await service.createApprovalExecute("appr-approved", new Date(now.getTime() - 1000), "recruiter follow-up email");

  const executed: string[] = [];
  const executeApproval: ExecuteApprovalFn = async (id) => { executed.push(id); return "sent"; };
  const { notify, messages } = fakeNotifier();
  const fired = await service.fireDue(notify, now, undefined, executeApproval);

  assert.equal(fired.length, 1);
  assert.equal(fired[0].status, "fired"); // one-shot, fire-once — never retries
  assert.deepEqual(executed, ["appr-approved"]);
  assert.deepEqual(messages, ["Sent scheduled approval recruiter follow-up email"]);

  const events = await activity.list(10);
  const event = events.find((item) => item.metadata?.id === reminder.id);
  assert.equal(event?.metadata?.approvalId, "appr-approved");
  assert.equal(event?.metadata?.error, undefined);
});

test("fireDue() skips (never retries) an approval.execute reminder whose approval isn't approved yet", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const now = new Date("2026-08-06T12:00:00Z");
  const reminder = await service.createApprovalExecute("appr-pending", new Date(now.getTime() - 1000), "recruiter follow-up email");

  const executeApproval: ExecuteApprovalFn = async () => {
    throw new Error("Approval appr-pending is pending; Luvish's explicit approval is required before execution");
  };
  const { notify, messages } = fakeNotifier();
  const fired = await service.fireDue(notify, now, undefined, executeApproval);

  assert.equal(fired.length, 1);
  assert.equal(fired[0].status, "fired"); // marked fired even on failure — no retry, ever
  assert.match(messages[0], /^Scheduled send skipped: Approval appr-pending is pending/);

  // A second poll must not attempt the send again.
  const secondExecuteApproval: ExecuteApprovalFn = async () => { throw new Error("should never be called again"); };
  const secondFired = await service.fireDue(notify, new Date(now.getTime() + 60_000), undefined, secondExecuteApproval);
  assert.equal(secondFired.length, 0);
  assert.equal(messages.length, 1);

  const events = await activity.list(10);
  const event = events.find((item) => item.metadata?.id === reminder.id);
  assert.equal(event?.metadata?.approvalId, "appr-pending");
  assert.match(String(event?.metadata?.error), /is pending/);
});

test("fireDue() reports a clear skip message when no executeApproval handler is configured", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const now = new Date("2026-08-06T12:00:00Z");
  await service.createApprovalExecute("appr-x", new Date(now.getTime() - 1000));

  const { notify, messages } = fakeNotifier();
  const fired = await service.fireDue(notify, now); // no executeApproval passed

  assert.equal(fired.length, 1);
  assert.equal(fired[0].status, "fired");
  assert.match(messages[0], /^Scheduled send skipped: no executeApproval handler configured$/);
});

// --- Shared reminder ticker (repl/dashboard/daemon all reuse this) --------------------------

test("startReminderTicker() guards against double-starting inside the same process", async () => {
  __resetReminderTickerForTests();
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);

  const first = startReminderTicker(service, activity, { pollMs: 60_000 });
  assert.ok(first, "first startReminderTicker() call should return a handle");

  const second = startReminderTicker(service, activity, { pollMs: 60_000 });
  assert.equal(second, undefined, "a second call in the same process must not start another ticker");

  first!.stop();

  const third = startReminderTicker(service, activity, { pollMs: 60_000 });
  assert.ok(third, "after stop(), a new ticker should be startable again");
  third!.stop();
});

test("startReminderTicker() never re-enters fireDue while a slow pass is in flight — overlapping polls fire exactly once", async () => {
  __resetReminderTickerForTests();
  const { config, activity } = await setup();
  let entries = 0;
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  // A fireDue slower than many poll intervals (a >60s prompt reminder, a slow send).
  const slowService = {
    fireDue: async () => { entries += 1; await gate; return []; },
  } as unknown as ReminderService;
  const lockPath = path.join(config.dataDir, "ticker-overlap.lock");
  const handle = startReminderTicker(slowService, activity, { pollMs: 15, lockPath });
  try {
    // ~8 poll intervals elapse while the first pass is stuck.
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(entries, 1, "overlapping polls must not re-enter fireDue (an approved email was observed re-SENDING once per tick)");
    releaseFirst();
    const deadline = Date.now() + 2_000;
    while (entries < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(entries >= 2, "once the slow pass completes, polling resumes normally");
  } finally { handle!.stop(); }
});

test("reminder ticker lock: a live owner with a fresh heartbeat keeps ownership; a stale heartbeat is taken over", async () => {
  __resetReminderTickerForTests();
  const { config, activity } = await setup();
  const lockPath = path.join(config.dataDir, "ticker-heartbeat.lock");
  await fs.mkdir(config.dataDir, { recursive: true });
  let fired = 0;
  const service = { fireDue: async () => { fired += 1; return []; } } as unknown as ReminderService;

  // A LIVE foreign pid (the test runner's parent) with a fresh heartbeat → respected.
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.ppid, role: "daemon", at: Date.now() }), "utf8");
  const blocked = startReminderTicker(service, activity, { pollMs: 60_000, lockPath, role: "daemon" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fired, 0, "a background ticker must not steal a live owner's lock");
  } finally { blocked!.stop(); }

  // Same live pid, but the heartbeat is ancient (SIGKILL'd owner + pid reuse) → stale, taken over.
  __resetReminderTickerForTests();
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.ppid, role: "daemon", at: Date.now() - 200_000 }), "utf8");
  const takeover = startReminderTicker(service, activity, { pollMs: 60_000, lockPath, role: "daemon" });
  try {
    const deadline = Date.now() + 2_000;
    while (fired === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(fired >= 1, "a stale heartbeat must not wedge every other ticker forever");
    const owner = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid: number };
    assert.equal(owner.pid, process.pid, "the takeover rewrites the lock to the new owner");
  } finally { takeover!.stop(); }
});

test("startReminderTicker() fires an immediate due-reminder check without waiting for the poll interval", async () => {
  __resetReminderTickerForTests();
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  await service.create("Immediate check", new Date(Date.now() - 1000));

  const { notify, messages } = fakeNotifier();
  const handle = startReminderTicker(service, activity, { notify, pollMs: 60_000 });
  try {
    // fireDue() runs asynchronously (real fs I/O) inside the ticker's immediate check;
    // poll briefly rather than assuming a fixed number of microtask flushes is enough.
    const deadline = Date.now() + 2_000;
    while (messages.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(messages, ["Immediate check"]);
  } finally {
    handle!.stop();
  }
});
