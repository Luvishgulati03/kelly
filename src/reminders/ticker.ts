import fs from "node:fs";
import path from "node:path";
import type { ActivityLog } from "../activity.ts";
import type { ReminderService, ReminderNotifier, PromptRunner, ExecuteApprovalFn } from "./service.ts";
import { notifyReminder } from "./service.ts";

/** How often any long-lived Henry process polls for due reminders (§ reminders doctrine). */
export const REMINDER_POLL_MS = 60_000;

export interface ReminderTickerHandle {
  stop(): void;
}

export type ReminderTickerRole = "repl" | "dashboard" | "daemon";

export interface ReminderTickerOptions {
  notify?: ReminderNotifier;
  promptRunner?: PromptRunner;
  executeApproval?: ExecuteApprovalFn;
  pollMs?: number;
  /** Interactive surfaces outrank background ones for delivery (repl > dashboard/daemon). */
  role?: ReminderTickerRole;
  /** Lock-file path; defaults to data/reminder-ticker.lock next to the reminders file. */
  lockPath?: string;
}

/**
 * Cross-process firing ownership. Multiple Henry processes (repl, dashboard, daemon)
 * all poll; without ownership, whichever polls first fires the reminder into ITS
 * surface — a background dashboard silently swallowing messages meant for Luvish's
 * terminal (observed 2026-08-06). Rule: one live owner fires; a repl always takes
 * over from background owners; background processes only claim a dead/absent lock.
 */
function claimOwnership(lockPath: string, role: ReminderTickerRole, staleMs: number): boolean {
  let owner: { pid: number; role: ReminderTickerRole; at?: number } | undefined;
  try { owner = JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch { owner = undefined; }
  // Heartbeat aging (audit 2026-08-09 B-H4): a SIGKILL'd owner's lock used to wedge
  // every other ticker forever (post-reboot pid reuse made the pid look alive). A
  // lock without a fresh heartbeat is stale regardless of pid liveness. EPERM from
  // kill(pid,0) means the pid EXISTS (another user's) — alive, same as the scheduler.
  const fresh = typeof owner?.at === "number" && Date.now() - owner.at < staleMs;
  const ownerAlive = owner && fresh
    ? (() => { try { process.kill(owner.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } })()
    : false;
  if (ownerAlive && owner!.pid !== process.pid) {
    if (role === "repl" && owner!.role !== "repl") {
      // Interactive takeover: the terminal Luvish is watching wins.
    } else {
      return false;
    }
  }
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, role, at: Date.now() }), { mode: 0o600 });
    return true;
  } catch { return false; }
}

/**
 * Guards against starting more than one reminder ticker inside a single process — the daemon
 * (`henry schedule daemon`) and the repl/dashboard commands all reuse this one implementation,
 * but each `henry ...` invocation is its own process so accidental double-starts only happen
 * within one process (e.g. a caller wiring it in twice).
 */
let started = false;

/**
 * Starts the shared reminder poller: an immediate check (so reminders that came due while
 * nothing was running fire right away, "(overdue)"-prefixed) followed by a fixed-interval
 * poll. Returns `undefined` if a ticker is already running in this process. The interval is
 * `unref()`d so it never keeps a REPL or short-lived process alive on its own — callers that
 * want to stop it explicitly (e.g. on REPL exit) should still call `handle.stop()`.
 */
export function startReminderTicker(
  reminders: ReminderService,
  activity: ActivityLog,
  options: ReminderTickerOptions = {},
): ReminderTickerHandle | undefined {
  if (started) return undefined;
  started = true;

  const notify = options.notify ?? notifyReminder;
  const pollMs = options.pollMs ?? REMINDER_POLL_MS;
  const role = options.role ?? "daemon";
  const lockPath = options.lockPath ?? path.join(path.dirname((reminders as unknown as { config?: { remindersPath?: string } }).config?.remindersPath ?? "data/reminders.json"), "reminder-ticker.lock");

  // In-flight guard (audit 2026-08-09 B-H3): a fireDue pass slower than one poll
  // (a >60s prompt reminder, a slow approved send) used to be re-entered every
  // tick — an approved email was observed re-SENDING once per minute for the
  // duration of the first send. One pass at a time, always.
  let fireInFlight = false;
  const check = (): void => {
    if (fireInFlight) return;
    if (!claimOwnership(lockPath, role, pollMs * 3)) return;
    fireInFlight = true;
    void reminders.fireDue(notify, new Date(), options.promptRunner, options.executeApproval)
      .catch((error) => activity.record("workflow.failed", "Reminder check failed", { error: String(error) }))
      .finally(() => { fireInFlight = false; });
  };

  check();
  const timer = setInterval(check, pollMs);
  timer.unref?.();

  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try {
        const owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid: number };
        if (owner.pid === process.pid) fs.rmSync(lockPath, { force: true });
      } catch { /* lock already gone */ }
      started = false;
    },
  };
}

/** Test-only: resets the double-start guard so each test gets a clean slate. */
export function __resetReminderTickerForTests(): void {
  started = false;
}
