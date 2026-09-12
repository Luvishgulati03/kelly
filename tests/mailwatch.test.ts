import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { MailWatchService, parseAlertLine, type MailWatchNotifier } from "../src/mailwatch/service.ts";
import type { HenryMemory } from "../src/memory/engram.ts";
import type { ProviderRunner } from "../src/providers/runner.ts";
import type { RunResult } from "../src/types.ts";

async function setup(): Promise<{ config: ReturnType<typeof loadConfig>; activity: ActivityLog }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-mailwatch-"));
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

function resultRunner(partial: Partial<RunResult>): ProviderRunner {
  return {
    run: async (): Promise<RunResult> => ({
      runId: "r1", provider: "codex", response: "NO_ALERTS", exitCode: 0, durationMs: 1, events: [], ...partial,
    }),
  } as unknown as ProviderRunner;
}

function fakeNotifier(): { notify: MailWatchNotifier; messages: Array<{ message: string; title?: string }> } {
  const messages: Array<{ message: string; title?: string }> = [];
  const notify: MailWatchNotifier = async (message, title) => { messages.push({ message, title }); };
  return { notify, messages };
}

test("parseAlertLine parses well-formed ALERT lines and rejects garbage", () => {
  const good = parseAlertLine("ALERT|msg-123|recruiter@acme.com|Interview scheduled|Interview invite for Thursday");
  assert.deepEqual(good, {
    id: "msg-123", from: "recruiter@acme.com", subject: "Interview scheduled", what: "Interview invite for Thursday",
  });
  assert.equal(parseAlertLine("NO_ALERTS"), undefined);
  assert.equal(parseAlertLine(""), undefined);
  assert.equal(parseAlertLine("just some prose the model emitted"), undefined);
  assert.equal(parseAlertLine("ALERT|only|three|parts"), undefined);
  // Missing id falls back to a deterministic hash, not undefined/blank.
  const noId = parseAlertLine("ALERT||recruiter@acme.com|Subject|what it is");
  assert.ok(noId && noId.id.startsWith("h"));
});

test("check() parses ALERT lines, notifies, records activity, and persists state", async () => {
  const { config, activity } = await setup();
  const response = [
    "ALERT|msg-1|recruiter@acme.com|You've been shortlisted|Shortlisting notice",
    "ALERT|msg-2|jobs@foo.com|Interview invitation|Interview scheduled for next week",
  ].join("\n");
  const { notify, messages } = fakeNotifier();
  const service = new MailWatchService(config, activity, fakeRunner(response), notify);

  const result = await service.check();
  assert.deepEqual(result.alerts.sort(), [
    "Interview invitation — from jobs@foo.com (Interview scheduled for next week)",
    "You've been shortlisted — from recruiter@acme.com (Shortlisting notice)",
  ].sort());
  assert.equal(messages.length, 2);
  assert.ok(messages.every((m) => m.title === "Henry — job mail"));

  const events = await activity.list(50);
  const mailwatchEvents = events.filter((e) => e.metadata?.mailwatch === true);
  assert.equal(mailwatchEvents.length, 2);

  const status = await service.status();
  assert.equal(status.seenCount, 2);
});

test("check() returns no alerts on NO_ALERTS and writes an updated lastCheckIso", async () => {
  const { config, activity } = await setup();
  const service = new MailWatchService(config, activity, fakeRunner("NO_ALERTS"));
  const before = await service.status();
  const result = await service.check();
  assert.deepEqual(result.alerts, []);
  const after = await service.status();
  assert.equal(after.seenCount, 0);
  assert.notEqual(after.lastCheckIso, before.lastCheckIso);
});

test("check() fails closed without advancing lastCheckIso on provider or response failures", async (t) => {
  const cases: Array<{ name: string; result: Partial<RunResult> }> = [
    { name: "limited", result: { response: "", exitCode: null, limited: true, error: "quota exhausted" } },
    { name: "error", result: { error: "provider exploded" } },
    { name: "nonzero exit", result: { response: "NO_ALERTS", exitCode: 1 } },
    { name: "null exit", result: { response: "NO_ALERTS", exitCode: null } },
    { name: "empty response", result: { response: "" } },
    { name: "malformed response", result: { response: "ALERT|msg-1|recruiter@acme.com|Interview scheduled|Thursday\nstray prose" } },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const { config, activity } = await setup();
      const baseline = new MailWatchService(config, activity, fakeRunner("NO_ALERTS"));
      await baseline.check();
      const before = await baseline.status();
      const failing = new MailWatchService(config, activity, resultRunner(fixture.result));

      await assert.rejects(() => failing.check(), /Mailwatch check failed closed/);
      const after = await failing.status();
      assert.equal(after.lastCheckIso, before.lastCheckIso);
      assert.equal(after.seenCount, before.seenCount);
    });
  }
});

test("check() does not advance the cursor when tracker persistence fails", async () => {
  const { config, activity } = await setup();
  const baseline = new MailWatchService(config, activity, fakeRunner("NO_ALERTS"));
  await baseline.check();
  const before = await baseline.status();

  await fs.mkdir(config.jobTrackerPath, { recursive: true });
  const service = new MailWatchService(
    config,
    activity,
    fakeRunner("APP|Acme Corp|SWE Intern|LinkedIn|applied|Aug 1|Application received"),
  );
  await assert.rejects(() => service.check());

  const after = await service.status();
  assert.equal(after.lastCheckIso, before.lastCheckIso);
  assert.equal(after.seenCount, before.seenCount);
});

test("check() serializes concurrent service instances without regressing the cursor or duplicating alerts", async () => {
  const { config, activity } = await setup();
  const prompts: string[] = [];
  let calls = 0;
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
  const runner = {
    run: async (prompt: string): Promise<RunResult> => {
      calls += 1;
      prompts.push(prompt);
      if (calls === 1) {
        firstEntered();
        await firstGate;
      }
      return {
        runId: `r${calls}`, provider: "codex",
        response: "ALERT|same-message|recruiter@acme.com|Interview scheduled|Interview on Thursday",
        exitCode: 0, durationMs: 1, events: [],
      };
    },
  } as unknown as ProviderRunner;
  const { notify, messages } = fakeNotifier();
  const firstService = new MailWatchService(config, activity, runner, notify);
  const secondService = new MailWatchService(config, activity, runner, notify);

  const firstCheck = firstService.check();
  await entered;
  const secondCheck = secondService.check();
  await new Promise<void>((resolve) => setTimeout(resolve, 75));
  assert.equal(calls, 1, "the second process-equivalent service must wait on the file lock");

  releaseFirst();
  const [first, second] = await Promise.all([firstCheck, secondCheck]);
  assert.equal(calls, 2);
  assert.equal(first.alerts.length, 1);
  assert.deepEqual(second.alerts, [], "the serialized later check sees the first check's dedupe state");
  assert.equal(messages.length, 1, "the same alert is delivered exactly once");
  assert.ok(new Date(second.checkedAt).getTime() >= new Date(first.checkedAt).getTime());
  assert.match(prompts[1], new RegExp(`after ${first.checkedAt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} that relate`));
  await assert.rejects(() => fs.access(`${config.mailwatchPath}.check.lock`), "the dedicated check lock is released");
});

test("check() uses a dedicated lock and does not deadlock behind scheduler's mailwatch.lock", async () => {
  const { config, activity } = await setup();
  const schedulerLock = path.join(config.dataDir, "mailwatch.lock");
  await fs.writeFile(schedulerLock, String(process.pid), "utf8");

  const result = await new MailWatchService(config, activity, fakeRunner("NO_ALERTS")).check();
  assert.deepEqual(result.alerts, []);
  assert.equal(await fs.readFile(schedulerLock, "utf8"), String(process.pid));
});

test("stale check-lock quarantine cannot delete a replacement lock with a different inode", async () => {
  const { config, activity } = await setup();
  const service = new MailWatchService(config, activity, fakeRunner("NO_ALERTS"));
  const lockPath = `${config.mailwatchPath}.check.lock`;
  const staleBody = JSON.stringify({ pid: 2_147_483_647, token: "stale" });
  await fs.writeFile(lockPath, staleBody, "utf8");
  const observedStat = await fs.stat(lockPath);

  await fs.unlink(lockPath);
  const replacementBody = JSON.stringify({ pid: process.pid, token: "replacement" });
  await fs.writeFile(lockPath, replacementBody, "utf8");
  const quarantined = await (service as unknown as {
    quarantineStaleCheckLock: (path: string, raw: string, stat: typeof observedStat) => Promise<boolean>;
  }).quarantineStaleCheckLock(lockPath, staleBody, observedStat);

  assert.equal(quarantined, false);
  assert.equal(await fs.readFile(lockPath, "utf8"), replacementBody, "an outdated stale observer must leave the replacement intact");
  assert.deepEqual((await fs.readdir(config.dataDir)).filter((name) => name.includes(".check.lock.stale-")), []);
});

test("check() reclaims a genuinely stale dead-process lock through quarantine", async () => {
  const { config, activity } = await setup();
  const lockPath = `${config.mailwatchPath}.check.lock`;
  await fs.writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, token: "dead" }), "utf8");

  const result = await new MailWatchService(config, activity, fakeRunner("NO_ALERTS")).check();
  assert.deepEqual(result.alerts, []);
  await assert.rejects(() => fs.access(lockPath));
});

test("check() preserves a newer stored cursor instead of regressing it", async () => {
  const { config, activity } = await setup();
  const futureCursor = "2099-01-01T00:00:00.000Z";
  await fs.writeFile(config.mailwatchPath, `${JSON.stringify({ lastCheckIso: futureCursor, seenIds: [] })}\n`, "utf8");

  const result = await new MailWatchService(config, activity, fakeRunner("NO_ALERTS")).check();
  assert.equal(result.checkedAt, futureCursor);
  assert.equal((await new MailWatchService(config, activity, fakeRunner("NO_ALERTS")).status()).lastCheckIso, futureCursor);
});

test("tracker delivery happens exactly once when cursor persistence fails and the check retries", async () => {
  const { config, activity } = await setup();
  const baseline = new MailWatchService(config, activity, fakeRunner("NO_ALERTS"));
  await baseline.check();
  const before = await baseline.status();
  const backupPath = `${config.mailwatchPath}.test-backup`;
  const remembered: string[] = [];
  const memory = {
    remember: async (content: string): Promise<string> => { remembered.push(content); return `m${remembered.length}`; },
  } as unknown as HenryMemory;
  const { notify: collectNotification, messages } = fakeNotifier();
  let sabotageCursorWrite = true;
  const notify: MailWatchNotifier = async (message, title) => {
    await collectNotification(message, title);
    if (title === "Henry — job tracker" && sabotageCursorWrite) {
      sabotageCursorWrite = false;
      await fs.rename(config.mailwatchPath, backupPath);
      await fs.mkdir(config.mailwatchPath);
    }
  };
  const response = "APP|Acme Corp|SWE Intern|LinkedIn|shortlisted|Aug 5|You've been shortlisted";
  const service = new MailWatchService(config, activity, fakeRunner(response), notify, memory);

  await assert.rejects(() => service.check());
  await fs.rmdir(config.mailwatchPath);
  await fs.rename(backupPath, config.mailwatchPath);
  assert.equal((await service.status()).lastCheckIso, before.lastCheckIso, "failed cursor write leaves the prior window intact");
  assert.equal(messages.filter((item) => item.title === "Henry — job tracker").length, 1);
  assert.equal(remembered.length, 1);

  await service.check();
  assert.equal(messages.filter((item) => item.title === "Henry — job tracker").length, 1, "tracker dedupe suppresses retry delivery");
  assert.equal(remembered.length, 1, "tracker memory is also recorded exactly once");
  assert.notEqual((await service.status()).lastCheckIso, before.lastCheckIso);
});

test("alert outbox commits cursor and seen state before delivery, then retries a failed notifier", async () => {
  const { config, activity } = await setup();
  const baseline = new MailWatchService(config, activity, fakeRunner("NO_ALERTS"));
  await baseline.check();
  const before = await baseline.status();
  let attempts = 0;
  const delivered: string[] = [];
  const failingNotifier: MailWatchNotifier = async () => {
    attempts += 1;
    throw new Error("notification channel unavailable");
  };
  const alert = "ALERT|interview-1|recruiter@acme.com|Interview scheduled|Interview on Thursday";

  await assert.rejects(
    () => new MailWatchService(config, activity, fakeRunner(alert), failingNotifier).check(),
    /notification channel unavailable/,
  );
  const committed = JSON.parse(await fs.readFile(config.mailwatchPath, "utf8")) as {
    lastCheckIso: string; seenIds: string[]; pendingAlerts: Array<{ id: string; message: string }>;
  };
  assert.notEqual(committed.lastCheckIso, before.lastCheckIso, "cursor commits before delivery is attempted");
  assert.deepEqual(committed.seenIds, ["interview-1"]);
  assert.equal(committed.pendingAlerts.length, 1, "failed delivery remains durable");
  assert.equal(attempts, 1);

  const order: string[] = [];
  const retryRunner = {
    run: async (): Promise<RunResult> => {
      order.push("scan");
      return { runId: "retry", provider: "codex", response: "NO_ALERTS", exitCode: 0, durationMs: 1, events: [] };
    },
  } as unknown as ProviderRunner;
  const retryNotifier: MailWatchNotifier = async (message) => {
    order.push("notify");
    attempts += 1;
    delivered.push(message);
  };
  await new MailWatchService(config, activity, retryRunner, retryNotifier).check();

  assert.deepEqual(order, ["notify", "scan"], "pending delivery is retried before the later mailbox scan");
  assert.equal(attempts, 2);
  assert.deepEqual(delivered, ["Interview scheduled — from recruiter@acme.com (Interview on Thursday)"]);
  const drained = JSON.parse(await fs.readFile(config.mailwatchPath, "utf8")) as { pendingAlerts: unknown[] };
  assert.deepEqual(drained.pendingAlerts, [], "only a resolved notifier removes the outbox item");
});

test("first run defaults lastCheckIso to now-24h", async () => {
  const { config, activity } = await setup();
  const before = Date.now();
  let capturedPrompt = "";
  const capturingRunner = {
    run: async (prompt: string): Promise<RunResult> => {
      capturedPrompt = prompt;
      return { runId: "r", provider: "codex", response: "NO_ALERTS", exitCode: 0, durationMs: 1, events: [] };
    },
  } as unknown as ProviderRunner;
  await new MailWatchService(config, activity, capturingRunner).check();
  const match = capturedPrompt.match(/after (\S+) that relate/);
  assert.ok(match, "prompt should embed lastCheckIso");
  const lookback = new Date(match![1]).getTime();
  assert.ok(Math.abs(before - 24 * 60 * 60 * 1000 - lookback) < 5000, "first-run lookback should be ~24h ago");
});

test("dedupes the same alert id across two separate check() calls", async () => {
  const { config, activity } = await setup();
  const response = "ALERT|dup-1|recruiter@acme.com|Assessment invite|Take the test by Friday";
  const first = await new MailWatchService(config, activity, fakeRunner(response)).check();
  const second = await new MailWatchService(config, activity, fakeRunner(response)).check();
  assert.equal(first.alerts.length, 1);
  assert.equal(second.alerts.length, 0);
  const status = await new MailWatchService(config, activity, fakeRunner("NO_ALERTS")).status();
  assert.equal(status.seenCount, 1);
});

test("state file persists across service instances and caps seenIds at 500", async () => {
  const { config, activity } = await setup();
  const manyLines = Array.from({ length: 520 }, (_, i) => `ALERT|id-${i}|from${i}@x.com|Subject ${i}|shortlisted`).join("\n");
  await new MailWatchService(config, activity, fakeRunner(manyLines)).check();
  const raw = JSON.parse(await fs.readFile(config.mailwatchPath, "utf8")) as { seenIds: string[] };
  assert.equal(raw.seenIds.length, 500);
});

// --- Randomized 5-checks/day plan (Luvish's request: cut codex calls ~6x vs. a check on every tick) ---

test("plan() generates 5 sorted times within the 08:00-23:00 local window", async () => {
  const { config, activity } = await setup();
  const service = new MailWatchService(config, activity, fakeRunner("NO_ALERTS"));
  const now = new Date(2026, 0, 15, 6, 0, 0);
  const plan = await service.plan(now);
  assert.equal(plan.date, "2026-01-15");
  assert.equal(plan.times.length, 5);
  assert.deepEqual(plan.fired, []);
  const sorted = [...plan.times].sort();
  assert.deepEqual(plan.times, sorted, "times must be sorted ascending");
  for (const iso of plan.times) {
    const local = new Date(iso);
    assert.equal(local.getFullYear(), 2026);
    assert.equal(local.getMonth(), 0);
    assert.equal(local.getDate(), 15);
    assert.ok(local.getHours() >= 8 && local.getHours() < 23, `${iso} must fall within 08:00-23:00 local`);
  }
  const uniqueMinutes = new Set(plan.times.map((iso) => new Date(iso).getHours() * 60 + new Date(iso).getMinutes()));
  assert.equal(uniqueMinutes.size, 5, "the 5 planned times must be distinct");
});

test("plan() is stable within a day and regenerates on date change", async () => {
  const { config, activity } = await setup();
  const service = new MailWatchService(config, activity, fakeRunner("NO_ALERTS"));
  const day1 = new Date(2026, 0, 15, 9, 0, 0);
  const first = await service.plan(day1);
  const second = await service.plan(new Date(2026, 0, 15, 20, 0, 0));
  assert.deepEqual(second, first, "same local day returns the persisted plan unchanged");

  const day2 = new Date(2026, 0, 16, 9, 0, 0);
  const third = await service.plan(day2);
  assert.equal(third.date, "2026-01-16");
  assert.notDeepEqual(third.times, first.times, "a new local day gets freshly generated times");
});

test("plan persists across service instances (re-read, not regenerated)", async () => {
  const { config, activity } = await setup();
  const now = new Date(2026, 0, 15, 9, 0, 0);
  const first = await new MailWatchService(config, activity, fakeRunner("NO_ALERTS")).plan(now);
  const second = await new MailWatchService(config, activity, fakeRunner("NO_ALERTS")).plan(now);
  assert.deepEqual(second, first);
  const raw = JSON.parse(await fs.readFile(config.mailwatchPlanPath, "utf8")) as { date: string; times: string[] };
  assert.deepEqual(raw.times, first.times);
});

test("tick() skips and reports nextPlannedAt when no planned time is due yet", async () => {
  const { config, activity } = await setup();
  const service = new MailWatchService(config, activity, fakeRunner("NO_ALERTS"));
  const now = new Date(2026, 0, 15, 8, 0, 0);
  const plan = await service.plan(now);
  const before = new Date(new Date(plan.times[0]).getTime() - 60_000); // 1 min before the first planned check
  const result = await service.tick(before);
  assert.deepEqual(result, { skipped: true, reason: "no planned mailwatch check due yet", nextPlannedAt: plan.times[0] });
});

test("tick() runs the real check exactly once when a planned time is due, then dedupes that index", async () => {
  const { config, activity } = await setup();
  let calls = 0;
  const countingRunner = {
    run: async (): Promise<RunResult> => { calls += 1; return { runId: `r${calls}`, provider: "codex", response: "NO_ALERTS", exitCode: 0, durationMs: 1, events: [] }; },
  } as unknown as ProviderRunner;
  const service = new MailWatchService(config, activity, countingRunner);
  const now = new Date(2026, 0, 15, 8, 0, 0);
  const plan = await service.plan(now);
  const due = new Date(plan.times[0]);

  const result = await service.tick(due);
  assert.equal(calls, 1, "a due planned time triggers exactly one real check");
  assert.ok("alerts" in result, "a fired tick returns the check() result shape");

  const afterFire = await service.plan(due);
  assert.deepEqual(afterFire.fired, [0]);

  // Ticking again at the same due time must not re-fire the same index.
  const secondTick = await service.tick(due);
  assert.equal(calls, 1, "the same planned index never fires twice");
  assert.deepEqual(secondTick, {
    skipped: true,
    reason: "no planned mailwatch check due yet",
    nextPlannedAt: plan.times[1],
  });
});

test("tick() retains a due planned slot when check() fails validation", async () => {
  const { config, activity } = await setup();
  const service = new MailWatchService(config, activity, resultRunner({ response: "unexpected prose" }));
  const morning = new Date(2026, 0, 15, 8, 0, 0);
  const plan = await service.plan(morning, () => 0);
  const due = new Date(plan.times[0]);

  await assert.rejects(() => service.tick(due), /malformed provider response/);
  const retained = await service.plan(due);
  assert.deepEqual(retained.fired, [], "the failed check's slot must remain available for retry");
});

test("status() surfaces today's plan alongside the existing fields", async () => {
  const { config, activity } = await setup();
  const service = new MailWatchService(config, activity, fakeRunner("NO_ALERTS"));
  const now = new Date(2026, 0, 15, 8, 0, 0);
  const status = await service.status(now);
  assert.equal(status.plan.date, "2026-01-15");
  assert.equal(status.plan.times.length, 5);
  assert.deepEqual(status.plan.fired, []);
  assert.deepEqual(status.plan.pending, status.plan.times);
  assert.equal(status.plan.nextPlannedAt, status.plan.times[0]);
});

test("status() is read-only — it previews a plan without ever persisting one", async () => {
  const { config, activity } = await setup();
  const service = new MailWatchService(config, activity, fakeRunner("NO_ALERTS"));
  const status = await service.status(new Date(2026, 0, 15, 9, 0, 0));
  assert.equal(status.plan.times.length, 5, "a computed preview is still returned");
  await assert.rejects(() => fs.access(config.mailwatchPlanPath), "status() must never create the plan file — only tick()/plan() write it");
});

test("a mid-day FIRST plan lays only future slots — never already-past ones that would fire instantly", async () => {
  const { config, activity } = await setup();
  const service = new MailWatchService(config, activity, fakeRunner("NO_ALERTS"));
  const now = new Date(2026, 0, 15, 14, 37, 0);
  const plan = await service.plan(now);
  assert.equal(plan.times.length, 5);
  for (const iso of plan.times) {
    const slot = new Date(iso);
    assert.ok(slot.getTime() > now.getTime(), `${iso} must be strictly in the future`);
    assert.ok(slot.getHours() < 23, `${iso} must stay inside the window`);
  }
  // A tick right after generation therefore has nothing due.
  const result = await service.tick(new Date(now.getTime() + 1000));
  assert.ok("skipped" in result && result.skipped === true, "no past slot may be instantly due after a mid-day plan");
});

test("tick() skips slots that went stale during a sleep instead of burning them back-to-back", async () => {
  const { config, activity } = await setup();
  let calls = 0;
  const countingRunner = {
    run: async (): Promise<RunResult> => { calls += 1; return { runId: `r${calls}`, provider: "codex", response: "NO_ALERTS", exitCode: 0, durationMs: 1, events: [] }; },
  } as unknown as ProviderRunner;
  const service = new MailWatchService(config, activity, countingRunner);
  const morning = new Date(2026, 0, 15, 8, 0, 0);
  // rng()=0 keeps the shuffle deterministic: slots land at 08:01..08:05.
  const plan = await service.plan(morning, () => 0);
  assert.equal(plan.times.length, 5);

  // Laptop wakes hours later: every unfired slot is long stale — none may fire.
  const afternoon = new Date(2026, 0, 15, 15, 0, 0);
  const stale = await service.tick(afternoon);
  assert.equal(calls, 0, "stale slots must be skipped, not machine-gunned");
  assert.ok("skipped" in stale && stale.skipped === true);
  assert.equal((stale as { nextPlannedAt?: string }).nextPlannedAt, undefined, "every slot is in the past — nothing is next");

  // A slot still inside the freshness window (one cron interval + slack) fires normally.
  const justAfterFirst = new Date(new Date(plan.times[0]).getTime() + 5 * 60 * 1000);
  const fired = await service.tick(justAfterFirst);
  assert.equal(calls, 1, "a freshly-due slot still fires");
  assert.ok("alerts" in fired);
});
