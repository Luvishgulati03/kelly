import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { ProviderRunner } from "../providers/runner.ts";
import { parseAppLine, updateTracker, type TrackerAppEvent } from "./tracker.ts";
import type { HenryMemory } from "../memory/engram.ts";

/** Same shape as reminders' `ReminderNotifier` — kept local so this module never imports the reminders module directly (doctrine rule 7). */
export type MailWatchNotifier = (message: string, title?: string) => Promise<void>;

const SEEN_ID_CAP = 500;
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const CHECK_LOCK_POLL_MS = 25;
const CHECK_LOCK_WAIT_MS = 10 * 60 * 1000;
const MALFORMED_CHECK_LOCK_STALE_MS = 10 * 60 * 1000;

interface MailWatchState {
  lastCheckIso: string;
  seenIds: string[];
  /** Normalized alert subjects with last-seen time — blast-dedupe window (7 days). */
  recentSubjects?: Array<{ key: string; at: string }>;
  /** Alerts durably committed with the cursor but not yet acknowledged by the notifier. */
  pendingAlerts?: PendingAlert[];
}

interface PendingAlert extends ParsedAlert {
  message: string;
  createdAt: string;
}

/**
 * Luvish's explicit request: stop hitting codex every 45 minutes (~32x/day) and instead run 5
 * random checks/day (~6x fewer calls). The cron tick stays frequent (every 30 min, see
 * workflows/defaults.json) purely as a scheduling heartbeat; this plan decides which ticks
 * actually do a check.
 */
const PLAN_CHECKS_PER_DAY = 5;
/** Inclusive local starting hour for planned checks. */
const PLAN_START_HOUR = 8;
/** Exclusive local ending hour for planned checks. */
const PLAN_END_HOUR = 23;
/**
 * One cron interval (30 min) + slack: an unfired slot older than this belongs to a
 * sleeping laptop's past — it is skipped, never fired, so a wake-up doesn't burn
 * the missed checks back-to-back.
 */
const STALE_SLOT_MS = 35 * 60 * 1000;

export interface MailWatchPlan {
  /** Local "YYYY-MM-DD" the plan's `times` belong to. */
  date: string;
  /** Sorted ISO timestamps, one per planned check for `date`. */
  times: string[];
  /** Indices into `times` that have already fired today. */
  fired: number[];
}

export type MailWatchTickResult = MailWatchResult | { skipped: true; reason: string; nextPlannedAt?: string };

/** Local "YYYY-MM-DD" — used to detect day rollover without any timezone library. */
function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Picks up to `count` distinct random minutes-of-day in `[max(now, startHour), endHour)` via a
 * partial Fisher-Yates shuffle (guarantees no duplicates in O(count) rng calls, unlike a
 * reject-loop). Only FUTURE minutes are eligible (audit M14a): a first plan generated mid-day
 * used to lay slots across the whole window, and every already-past slot then read as instantly
 * due — burning most of the day's checks back-to-back. Near the end of the window this can
 * legitimately return FEWER than `count` slots (or none after endHour).
 * This is deliberately runtime randomness (Math.random by default) — not a workflow script, so
 * MASTER_PLAN's "no Math.random in generated workflow output" rule doesn't apply here. `rng` is
 * injectable so tests can assert exact slot placement.
 */
function planTimesForDate(date: Date, count: number, startHour: number, endHour: number, rng: () => number = Math.random): string[] {
  const startMinute = Math.max(startHour * 60, date.getHours() * 60 + date.getMinutes() + 1);
  const endMinute = endHour * 60;
  const available = Array.from({ length: Math.max(0, endMinute - startMinute) }, (_, index) => startMinute + index);
  const slots = Math.min(count, available.length);
  for (let index = 0; index < slots; index += 1) {
    const offset = Math.min(available.length - index - 1, Math.floor(Math.max(0, Math.min(0.999999999, rng())) * (available.length - index)));
    const selected = index + offset;
    [available[index], available[selected]] = [available[selected], available[index]];
  }
  return available.slice(0, slots).sort((a, b) => a - b).map((minute) => {
    const slot = new Date(date);
    slot.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
    return slot.toISOString();
  });
}

export interface ParsedAlert {
  id: string;
  from: string;
  subject: string;
  what: string;
}

export interface MailWatchResult {
  alerts: string[];
  checkedAt: string;
}

/** Cheap, deterministic fallback id when the model doesn't give us a real message id. */
function subjectHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) hash = (hash * 31 + input.charCodeAt(i)) | 0;
  return `h${Math.abs(hash)}`;
}

/**
 * Defensively parses one `ALERT|<id>|<from>|<subject>|<what>` line. Returns `undefined` for
 * `NO_ALERTS`, blank lines, or anything else that doesn't match — the model's raw output is
 * never trusted structurally.
 */
export function parseAlertLine(line: string): ParsedAlert | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("ALERT|")) return undefined;
  const parts = trimmed.split("|");
  if (parts.length < 5) return undefined;
  const [, rawId, from, subject, ...rest] = parts;
  const what = rest.join("|").trim();
  const fromTrimmed = from.trim();
  const subjectTrimmed = subject.trim();
  if (!fromTrimmed || !subjectTrimmed || !what) return undefined;
  // Sanity floor (2026-08-11: a mangled model line became the alert "✉️ Job \\"):
  // a real subject has letters and some length; anything else is model noise.
  if (subjectTrimmed.length < 6 || !/[a-z]{3}/i.test(subjectTrimmed)) return undefined;
  const id = rawId.trim() || subjectHash(`${fromTrimmed}|${subjectTrimmed}`);
  return { id, from: fromTrimmed, subject: subjectTrimmed, what };
}

export class MailWatchService {
  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    private readonly runner: ProviderRunner,
    private readonly notify?: MailWatchNotifier,
    private readonly memory?: HenryMemory,
  ) {}

  /**
   * Serializes the complete mailbox transaction across service instances and processes. This
   * intentionally does NOT use scheduler's `data/mailwatch.lock`: scheduler may already hold
   * that outer lock while calling tick(), so reusing it here would self-deadlock. A live PID is
   * never evicted merely for being old; dead holders are reclaimed, while a malformed lock gets
   * a generous grace period in case another process has created but not populated it yet.
   */
  private async withCheckLock<T>(work: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    const lockPath = `${this.config.mailwatchPath}.check.lock`;
    const token = `${process.pid}:${randomUUID()}`;
    const body = JSON.stringify({ pid: process.pid, token });
    const deadline = Date.now() + CHECK_LOCK_WAIT_MS;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;

    while (!handle) {
      try {
        handle = await fs.open(lockPath, "wx", 0o600);
        await handle.writeFile(body, "utf8");
      } catch (error) {
        if (handle) {
          await handle.close().catch(() => undefined);
          handle = undefined;
          await fs.rm(lockPath, { force: true }).catch(() => undefined);
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

        const [raw, stat] = await Promise.all([
          fs.readFile(lockPath, "utf8").catch(() => ""),
          fs.stat(lockPath).catch(() => undefined),
        ]);
        let pid: number | undefined;
        try {
          const owner = JSON.parse(raw) as { pid?: unknown };
          if (typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0) pid = owner.pid;
        } catch { pid = undefined; }
        let alive = false;
        if (pid !== undefined) {
          try { process.kill(pid, 0); alive = true; }
          catch (killError) { alive = (killError as NodeJS.ErrnoException).code !== "ESRCH"; }
        }
        const malformedAndStale = pid === undefined && !!stat && Date.now() - stat.mtimeMs > MALFORMED_CHECK_LOCK_STALE_MS;
        if ((pid !== undefined && !alive) || malformedAndStale) {
          await this.quarantineStaleCheckLock(lockPath, raw, stat);
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for mailwatch check lock at ${lockPath}`);
        await new Promise<void>((resolve) => setTimeout(resolve, CHECK_LOCK_POLL_MS));
      }
    }

    try {
      return await work();
    } finally {
      await handle.close().catch(() => undefined);
      const current = await fs.readFile(lockPath, "utf8").catch(() => "");
      if (current === body) await fs.rm(lockPath, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Pins the observed stale inode with a hard link before unlinking the public lock name. If an
   * owner released and another process replaced the lock after our observation, its inode will
   * differ and is left untouched. The unique quarantine link is always cleaned up afterwards.
   */
  private async quarantineStaleCheckLock(
    lockPath: string,
    observedRaw: string,
    observedStat: Awaited<ReturnType<typeof fs.stat>> | undefined,
  ): Promise<boolean> {
    if (!observedStat) return false;
    const quarantinePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
    try {
      await fs.link(lockPath, quarantinePath);
      const [quarantinedStat, currentStat, currentRaw] = await Promise.all([
        fs.stat(quarantinePath),
        fs.stat(lockPath).catch(() => undefined),
        fs.readFile(lockPath, "utf8").catch(() => undefined),
      ]);
      const observedWasPinned = quarantinedStat.dev === observedStat.dev && quarantinedStat.ino === observedStat.ino;
      const pathStillPinned = !!currentStat && currentStat.dev === quarantinedStat.dev && currentStat.ino === quarantinedStat.ino;
      if (!observedWasPinned || !pathStillPinned || currentRaw !== observedRaw) return false;
      await fs.unlink(lockPath);
      return true;
    } catch (error) {
      if (["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw error;
    } finally {
      await fs.unlink(quarantinePath).catch(() => undefined);
    }
  }

  /**
   * Every tracker event becomes a durable Engram memory, so "have I applied to X?"
   * recalls the application trail by company name. Semantic tier (facts, no decay);
   * importance follows the stakes of the status.
   */
  private async memorizeAppEvents(events: TrackerAppEvent[]): Promise<void> {
    if (!this.memory) return;
    const weight: Record<string, number> = { offer: 9, interview: 8, assessment: 8, shortlisted: 8, rejected: 6, viewed: 5, applied: 6 };
    for (const event of events) {
      const action = event.pendingAction ? ` Pending action: ${event.pendingAction.replace(/_/g, " ")}.` : "";
      await this.memory.remember(
        `Job application ${event.isNew ? "tracked" : "status update"}: ${event.company} — ${event.role} → ${event.status.toUpperCase()} (${event.dateText}).${action} Email subject: "${event.subject}"`,
        { tier: "semantic", importance: weight[event.status] ?? 5, metadata: { domain: "jobs", kind: "application-update", company: event.company, role: event.role, status: event.status, ...(event.pendingAction ? { pendingAction: event.pendingAction } : {}) } },
      ).catch(() => "");
    }
  }

  private async readState(): Promise<MailWatchState> {
    try {
      const raw = JSON.parse(await fs.readFile(this.config.mailwatchPath, "utf8")) as Partial<MailWatchState>;
      return {
        lastCheckIso: typeof raw.lastCheckIso === "string" ? raw.lastCheckIso : new Date(Date.now() - FIRST_RUN_LOOKBACK_MS).toISOString(),
        seenIds: Array.isArray(raw.seenIds) ? raw.seenIds.filter((item): item is string => typeof item === "string") : [],
        recentSubjects: Array.isArray(raw.recentSubjects)
          ? raw.recentSubjects.filter((entry): entry is { key: string; at: string } => !!entry && typeof entry.key === "string" && typeof entry.at === "string")
          : [],
        pendingAlerts: Array.isArray(raw.pendingAlerts)
          ? raw.pendingAlerts.filter((entry): entry is PendingAlert => !!entry && typeof entry.id === "string"
            && typeof entry.from === "string" && typeof entry.subject === "string" && typeof entry.what === "string"
            && typeof entry.message === "string" && typeof entry.createdAt === "string")
          : [],
      };
    } catch {
      return { lastCheckIso: new Date(Date.now() - FIRST_RUN_LOOKBACK_MS).toISOString(), seenIds: [] };
    }
  }

  private async writeState(state: MailWatchState): Promise<void> {
    await fs.mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    const capped: MailWatchState = {
      lastCheckIso: state.lastCheckIso,
      seenIds: state.seenIds.slice(-SEEN_ID_CAP),
      recentSubjects: state.recentSubjects?.slice(-100),
      pendingAlerts: state.pendingAlerts ?? [],
    };
    // tmp+rename (audit 2026-08-09 B-H5): a torn read of this file re-notifies a whole day.
    const tmp = `${this.config.mailwatchPath}.tmp-${process.pid}`;
    await fs.writeFile(tmp, `${JSON.stringify(capped, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, this.config.mailwatchPath);
    await fs.chmod(this.config.mailwatchPath, 0o600).catch(() => undefined);
  }

  async status(now: Date = new Date()): Promise<{
    lastCheckIso: string;
    seenCount: number;
    plan: { date: string; times: string[]; fired: string[]; pending: string[]; nextPlannedAt?: string };
  }> {
    const state = await this.readState();
    // Read-only (audit M14c): status must never WRITE a plan — a CLI status call
    // racing the cron tick could clobber fired indices. Show the stored plan when
    // it's current, otherwise an UNPERSISTED preview of what the next tick would
    // generate; the tick itself remains the only plan writer.
    const today = localDateKey(now);
    const currentPlan = this.reusablePlan(await this.readPlan(), today)
      ?? { date: today, times: planTimesForDate(now, PLAN_CHECKS_PER_DAY, PLAN_START_HOUR, PLAN_END_HOUR), fired: [] };
    const fired = currentPlan.times.filter((_, index) => currentPlan.fired.includes(index));
    const pending = currentPlan.times.filter((_, index) => !currentPlan.fired.includes(index));
    return {
      lastCheckIso: state.lastCheckIso,
      seenCount: state.seenIds.length,
      plan: {
        date: currentPlan.date, times: currentPlan.times, fired, pending,
        // Future slots only — a stale (skipped) slot must not advertise itself as "next".
        nextPlannedAt: pending.find((time) => new Date(time).getTime() > now.getTime()),
      },
    };
  }

  private async readPlan(): Promise<MailWatchPlan | undefined> {
    try {
      const raw = JSON.parse(await fs.readFile(this.config.mailwatchPlanPath, "utf8")) as Partial<MailWatchPlan>;
      if (typeof raw.date !== "string" || !Array.isArray(raw.times)) return undefined;
      return {
        date: raw.date,
        times: raw.times.filter((item): item is string => typeof item === "string"),
        fired: Array.isArray(raw.fired) ? raw.fired.filter((item): item is number => typeof item === "number") : [],
      };
    } catch { return undefined; }
  }

  private async writePlan(plan: MailWatchPlan): Promise<void> {
    await fs.mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    const tmpPlan = `${this.config.mailwatchPlanPath}.tmp-${process.pid}`;
    await fs.writeFile(tmpPlan, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmpPlan, this.config.mailwatchPlanPath);
    await fs.chmod(this.config.mailwatchPlanPath, 0o600).catch(() => undefined);
  }

  /**
   * A stored plan is reusable when it's for today and not over-length. Length may
   * legitimately be SHORT of PLAN_CHECKS_PER_DAY — a first plan generated late in
   * the day only had a few future minutes to place slots in — so only over-length
   * (garbage or a shrunk constant) forces regeneration.
   */
  private reusablePlan(plan: MailWatchPlan | undefined, today: string): MailWatchPlan | undefined {
    return plan && plan.date === today && plan.times.length <= PLAN_CHECKS_PER_DAY ? plan : undefined;
  }

  /**
   * Returns today's randomized check-times plan, generating a fresh one of up to
   * `PLAN_CHECKS_PER_DAY` future times (persisted) whenever the stored plan is missing,
   * malformed, or dated for a previous local day. Idempotent within a single day —
   * repeated calls return the same persisted plan.
   */
  async plan(now: Date = new Date(), rng: () => number = Math.random): Promise<MailWatchPlan> {
    const today = localDateKey(now);
    const existing = this.reusablePlan(await this.readPlan(), today);
    if (existing) return existing;
    const fresh: MailWatchPlan = {
      date: today,
      times: planTimesForDate(now, PLAN_CHECKS_PER_DAY, PLAN_START_HOUR, PLAN_END_HOUR, rng),
      fired: [],
    };
    await this.writePlan(fresh);
    return fresh;
  }

  /**
   * Called on every cron tick (every 30 min — see workflows/defaults.json). Regenerates the plan
   * on day rollover, then only actually runs `check()` if a planned time is now due and hasn't
   * fired yet; otherwise it's a no-op that reports the next planned time. This is what turns a
   * frequent cron tick into ~5 real codex calls/day instead of one per tick.
   */
  async tick(now: Date = new Date()): Promise<MailWatchTickResult> {
    const currentPlan = await this.plan(now);
    // A slot is due when its time has arrived AND it isn't stale (audit M14b):
    // after a laptop sleep the old first-unfired-past-slot rule fired every
    // missed slot on consecutive ticks, machine-gunning the day's quota.
    const dueIndex = currentPlan.times.findIndex((time, index) => {
      if (currentPlan.fired.includes(index)) return false;
      const age = now.getTime() - new Date(time).getTime();
      return age >= 0 && age <= STALE_SLOT_MS;
    });
    if (dueIndex === -1) {
      const nextPlannedAt = currentPlan.times.find(
        (time, index) => !currentPlan.fired.includes(index) && new Date(time).getTime() > now.getTime(),
      );
      return { skipped: true, reason: "no planned mailwatch check due yet", nextPlannedAt };
    }
    const result = await this.check();
    // Re-read right before marking fired — never trust the copy read at the top of this call
    // (the reminders-store clobber lesson: two processes writing the same JSON).
    const fresh = await this.plan(now);
    if (!fresh.fired.includes(dueIndex)) {
      fresh.fired = [...fresh.fired, dueIndex].sort((a, b) => a - b);
      await this.writePlan(fresh);
    }
    return result;
  }

  /**
   * One ProviderRunner.run call (codex primary — it has the authed gmail MCP), read-only,
   * no fallback provider. Alerts are deduped against `data/mailwatch.json` and the state file
   * is re-read immediately before writing — the reminders-store clobber lesson (two processes
   * writing the same JSON) applies here too.
   */
  async check(): Promise<MailWatchResult> {
    return this.withCheckLock(() => this.checkLocked());
  }

  private async checkLocked(): Promise<MailWatchResult> {
    const checkedAt = new Date().toISOString();
    const state = await this.deliverPendingAlerts(await this.readState());
    const prompt = [
      "Read-only task. Search my Gmail inbox for messages received after", state.lastCheckIso,
      "that relate to job applications: shortlisting, resume selected, interview",
      "scheduled/invitation, assessment/test invites, offer letters, or a PERSONAL recruiter",
      "message addressed to me specifically.",
      "Do NOT alert on rejections (\"not moving forward\", \"unfortunately\", \"other candidates\")",
      "or on plain application acknowledgements (\"thanks for applying\", \"application sent\").",
      "Those are recorded silently in the tracker and must never buzz the phone — only forward",
      "movement does. Still emit their APP| line below so the index stays complete.",
      "Do NOT alert on automated job-recommendation blasts: LinkedIn 'you're invited to apply'/",
      "'jobs for you'/'new jobs matching your alert' digests, Naukri/Indeed recommendation",
      "emails, newsletters. Those are marketing volume, not outcomes — skip them entirely",
      "(they are handled by a separate pipeline).",
      "DO NOT modify anything in the mailbox (no read-state, labels, drafts).",
      "For each match output exactly one line: ALERT|<message-id-or-subject-hash>|<from>|<subject>|<one-clause what it is>.",
      "Also search the same window for application-lifecycle emails: application confirmations",
      "(\"your application was sent to X\", \"thanks for applying\", \"application received\") from",
      "LinkedIn Easy Apply, Naukri, or direct company portals, plus status updates (viewed,",
      "shortlisted, assessment invite, interview scheduled) and outcomes (rejected, offer).",
      "For each such email output exactly one line: APP|<company>|<role>|<source: LinkedIn, Naukri,",
      "or direct>|<status: applied, viewed, shortlisted, assessment, interview, rejected, or",
      "offer>|<date-ish from the email>|<subject>. One email may produce both an ALERT and an APP",
      "line when it qualifies for both.",
      "Search results only expose subject/snippet. For every likely lifecycle match, fetch and read",
      "the full email body before classifying it; never classify a likely match from subject/snippet",
      "alone. Body-only requests for questionnaires, screening questions, additional details or",
      "forms, assessments/tests, and referrals are actionable lifecycle updates. Append",
      "|ACTION=<questionnaire|screening_questions|additional_details|assessment|referral> to its APP",
      "line when one is pending; omit the suffix when no action is pending.",
      "If nothing matches either category, output exactly NO_ALERTS.",
    ].join(" ");

    const result = await this.runner.run(prompt, { provider: "codex", readOnly: true, role: "mailwatch" });
    if (result.limited) throw new Error(`Mailwatch check failed closed: provider limited${result.error ? ` (${result.error})` : ""}`);
    if (result.error !== undefined) throw new Error(`Mailwatch check failed closed: provider error (${result.error || "unknown error"})`);
    if (result.exitCode !== 0) throw new Error(`Mailwatch check failed closed: provider exit code ${result.exitCode ?? "null"}`);

    const response = result.response.trim();
    const parsed: ParsedAlert[] = [];
    const appLines: string[] = [];
    if (response !== "NO_ALERTS") {
      if (!response) throw new Error("Mailwatch check failed closed: empty provider response");
      for (const line of response.split(/\r?\n/)) {
        const alert = parseAlertLine(line);
        const app = parseAppLine(line);
        if (alert) parsed.push(alert);
        else if (app) appLines.push(line.trim());
        else throw new Error(`Mailwatch check failed closed: malformed provider response line (${line.trim() || "empty line"})`);
      }
    }

    // Re-read right before writing — never trust the copy read at the top of this call.
    const fresh = await this.readState();
    const seen = new Set(fresh.seenIds);
    // Blast-dedupe (2026-08-11): recommendation emails re-arrive daily with near-identical
    // subjects — each IS a new email, so id-dedupe passes and Luvish got the same ping
    // 5x/day. A normalized subject seen in the last 7 days never re-alerts.
    const normalize = (subject: string) => subject.toLowerCase().replace(/[^a-z]+/g, " ").replace(/\d+/g, "#").trim().slice(0, 80);
    const recent = new Map((fresh.recentSubjects ?? []).map((entry) => [entry.key, entry.at]));
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    const newAlerts: Array<{ alert: ParsedAlert; message: string }> = [];
    for (const alert of parsed) {
      if (seen.has(alert.id)) continue;
      seen.add(alert.id);
      const key = normalize(alert.subject);
      const lastSeenAt = recent.get(key);
      if (lastSeenAt && new Date(lastSeenAt).getTime() > cutoff) continue;
      recent.set(key, new Date().toISOString());
      const message = `${alert.subject} — from ${alert.from} (${alert.what})`;
      newAlerts.push({ alert, message });
    }

    // Tracker persistence is part of the scan transaction. If it fails, leave lastCheckIso at
    // the previous cursor so the same mailbox window is retried instead of silently discarded.
    const tracker = appLines.length ? await updateTracker(this.config, appLines) : undefined;

    // Tracker dedupe is the durable delivery marker. Deliver these effects after its commit but
    // before advancing the mail cursor: if cursor persistence fails, the retry sees the same
    // APP lines, updateTracker returns no events/notifications, and these are not emitted twice.
    if (tracker) {
      for (const message of tracker.notifications) {
        if (this.notify) await this.notify(message, "Henry — job tracker").catch(() => undefined);
        await this.activity.record("workflow.completed", message, { jobTracker: true }).catch(() => undefined);
      }
      await this.memorizeAppEvents(tracker.events);
    }

    const freshCursorMs = new Date(fresh.lastCheckIso).getTime();
    const nextCursor = Number.isFinite(freshCursorMs) && freshCursorMs > new Date(checkedAt).getTime()
      ? fresh.lastCheckIso
      : checkedAt;
    const pendingById = new Map((fresh.pendingAlerts ?? []).map((alert) => [alert.id, alert]));
    for (const { alert, message } of newAlerts) {
      if (!pendingById.has(alert.id)) pendingById.set(alert.id, { ...alert, message, createdAt: checkedAt });
    }
    const committedState: MailWatchState = {
      lastCheckIso: nextCursor,
      seenIds: Array.from(seen),
      recentSubjects: [...recent.entries()].filter(([, at]) => new Date(at).getTime() > cutoff)
        .slice(-100).map(([key, at]) => ({ key, at })),
      pendingAlerts: [...pendingById.values()],
    };
    await this.writeState(committedState);

    await this.deliverPendingAlerts(committedState);

    return { alerts: newAlerts.map(({ message }) => message), checkedAt: nextCursor };
  }

  /**
   * Drains the durable alert outbox in order. An item is removed only after notify resolves and
   * that acknowledgement is persisted. If notify or the state write fails, the item remains on
   * disk for a later check; a post-delivery write failure may duplicate it, which is the intended
   * at-least-once safety tradeoff for interview/offer alerts.
   */
  private async deliverPendingAlerts(state: MailWatchState): Promise<MailWatchState> {
    if (!this.notify || !state.pendingAlerts?.length) return state;
    let current = { ...state, pendingAlerts: [...state.pendingAlerts] };
    while (current.pendingAlerts.length) {
      const pending = current.pendingAlerts[0];
      await this.notify(pending.message, "Henry — job mail");
      await this.activity.record("workflow.completed", `Job-mail alert: ${pending.subject}`, {
        mailwatch: true, id: pending.id, from: pending.from, subject: pending.subject, what: pending.what,
      }).catch(() => undefined);
      current = { ...current, pendingAlerts: current.pendingAlerts.slice(1) };
      await this.writeState(current);
    }
    return current;
  }

  /**
   * One-off, read-only provider call scanning the last `days` of inbox for application-lifecycle
   * emails (same APP| format as `check()`), to seed the ledger for someone who's been applying
   * for a while before Henry started watching. Deliberately does not touch `check()`'s
   * lastCheckIso/seenIds state — this is a separate seeding sweep, not a recurring check.
   */
  async backfill(days = 30): Promise<{ appLines: number; created: number; changed: number; notifications: string[] }> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const prompt = [
      "Read-only task. Search my Gmail inbox for messages received after", since,
      "that relate to job applications: application confirmations (\"your application was sent to X\",",
      "\"thanks for applying\", \"application received\") from LinkedIn Easy Apply, Naukri, or direct",
      "company portals, plus status updates (viewed, shortlisted, assessment invite, interview",
      "scheduled) and outcomes (rejected, offer). DO NOT modify anything in the mailbox (no",
      "read-state, labels, drafts). For each match output exactly one line:",
      "APP|<company>|<role>|<source: LinkedIn, Naukri, or direct>|<status: applied, viewed,",
      "shortlisted, assessment, interview, rejected, or offer>|<date-ish from the email>|<subject>.",
      "Search results only expose subject/snippet. For every likely lifecycle match, fetch and read",
      "the full email body before classification; do not rely on subject/snippet alone. Detect",
      "body-only pending questionnaires (including Gemba-style questionnaires), screening questions",
      "(including Albertsons), requests for additional details/forms (including Swiggy), assessments,",
      "and referrals (including IRIS). Append |ACTION=<questionnaire|screening_questions|additional_details|assessment|referral>",
      "to the APP line when pending; omit it otherwise. Use status assessment for an assessment",
      "request; for other actions use the lifecycle status evidenced by the email (usually shortlisted).",
      "If none, output exactly NO_ALERTS.",
    ].join(" ");

    const result = await this.runner.run(prompt, { provider: "codex", readOnly: true, role: "mailwatch-backfill" });
    const appLines = result.response.split(/\r?\n/).filter((line) => line.trim().startsWith("APP|"));
    const tracker = await updateTracker(this.config, appLines, { backfill: true });
    // ONE summary ping (audit M17): a 30-day sweep used to blast one notification
    // per historical event. Counts only — the regenerated ledger holds the detail.
    const notifications: string[] = [];
    if (tracker.created > 0 || tracker.changed > 0) {
      const summary = `📋 Backfill: seeded ${tracker.created} application${tracker.created === 1 ? "" : "s"}, ${tracker.changed} status update${tracker.changed === 1 ? "" : "s"} from the last ${days} days`;
      notifications.push(summary);
      if (this.notify) await this.notify(summary, "Henry — job tracker").catch(() => undefined);
      await this.activity.record("workflow.completed", summary, { jobTracker: true, backfill: true, created: tracker.created, changed: tracker.changed });
    }
    await this.memorizeAppEvents(tracker.events);
    return { appLines: appLines.length, created: tracker.created, changed: tracker.changed, notifications };
  }
}
