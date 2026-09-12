import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { HenryConfig } from "../config.ts";

/** Same rails as `service.ts`'s `MailWatchNotifier` — no shared type, kept local (doctrine rule 7). */

export const APP_STATUSES = ["applied", "viewed", "shortlisted", "assessment", "interview", "rejected", "offer"] as const;
export type AppStatus = (typeof APP_STATUSES)[number];
export const PENDING_ACTIONS = ["questionnaire", "screening_questions", "additional_details", "assessment", "referral"] as const;
export type PendingAction = (typeof PENDING_ACTIONS)[number];

/**
 * Statuses worth buzzing Luvish's phone about (his rule, 2026-08-15): "don't remind me for
 * applied applications, only if the application has had a response other than rejected —
 * keep updating the job index and send me that, not reminders".
 *
 * So `applied` (an acknowledgement, not a response) and `rejected` (a response, but not one
 * he wants pinged) are recorded SILENTLY. The tracker index, the history trail, and the
 * Engram events stay complete for every status — this set gates notifications only.
 */
export const NOTIFY_STATUSES: ReadonlySet<AppStatus> = new Set<AppStatus>([
  "viewed", "shortlisted", "assessment", "interview", "offer",
]);

function isAppStatus(value: string): value is AppStatus {
  return (APP_STATUSES as readonly string[]).includes(value);
}

export interface StructuredTrackerEvent {
  /** Stable Henry draft ID. Present for browser submissions; absent for email-derived fallback events. */
  applicationId?: string;
  company: string;
  role: string;
  source: string;
  status: AppStatus;
  dateText: string;
  subject: string;
  pendingAction?: PendingAction;
}

export interface ParsedApp extends StructuredTrackerEvent {}

/**
 * Defensively parses one `APP|<company>|<role>|<source>|<status>|<date-ish>|<subject>[|ACTION=<kind>]` line —
 * mirrors `parseAlertLine`'s discipline in `service.ts`. The model's raw output is never trusted
 * structurally: missing fields, an unknown status, or a short/garbage line all return `undefined`.
 */
export function parseAppLine(line: string): ParsedApp | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("APP|")) return undefined;
  const parts = trimmed.split("|");
  if (parts.length < 7) return undefined;
  const [, rawCompany, rawRole, rawSource, rawStatus, rawDate, ...rest] = parts;
  const company = rawCompany.trim().replace(/\|/g, "/");
  const role = rawRole.trim().replace(/\|/g, "/");
  const source = rawSource.trim().replace(/\|/g, "/");
  const status = rawStatus.trim().toLowerCase();
  const dateText = rawDate.trim();
  const actionMatch = rest.at(-1)?.trim().match(/^ACTION=(questionnaire|screening_questions|additional_details|assessment|referral)$/i);
  const pendingAction = actionMatch?.[1].toLowerCase() as PendingAction | undefined;
  const subject = (pendingAction ? rest.slice(0, -1) : rest).join("|").trim();
  if (!company || !role || !source || !subject) return undefined;
  if (!isAppStatus(status)) return undefined;
  return { company, role, source, status, dateText: dateText || "unknown", subject, ...(pendingAction ? { pendingAction } : {}) };
}

export interface TrackerHistoryEntry {
  status: AppStatus;
  /** The "date-ish" text lifted from the email — never parsed into a real Date (too unreliable across providers). */
  dateText: string;
  subject: string;
  /** ISO timestamp of when Henry actually recorded this transition. */
  recordedAt: string;
  /** True when recorded by a backfill() seeding sweep — digests must not count these as "today's" news. */
  backfill?: boolean;
  pendingAction?: PendingAction;
}

export interface TrackerEntry {
  /** Draft-backed records use `application:<id>`; email fallback keeps `company::role`. */
  key: string;
  applicationId?: string;
  company: string;
  role: string;
  source: string;
  status: AppStatus;
  appliedAt: string;
  lastUpdate: string;
  history: TrackerHistoryEntry[];
  pendingAction?: PendingAction;
}

export interface TrackerState {
  entries: TrackerEntry[];
}

/** One concrete application event (new application or status transition) — the unit the memory layer records. */
export interface TrackerAppEvent {
  applicationId?: string;
  company: string;
  role: string;
  status: AppStatus;
  subject: string;
  dateText: string;
  isNew: boolean;
  pendingAction?: PendingAction;
}

export interface TrackerUpdateResult {
  /** One "📋 Application update: ..." message per genuinely new application or status transition. */
  notifications: string[];
  created: number;
  changed: number;
  /** Mirrors notifications 1:1 with structured data, so callers can memorize transitions. */
  events: TrackerAppEvent[];
}

export interface TrackerSummary {
  jsonPath: string;
  markdownPath: string;
  total: number;
  byStatus: Record<AppStatus, number>;
}

function entryKey(company: string, role: string, applicationId?: string): string {
  if (applicationId) return `application:${applicationId}`;
  return `${company.trim().toLowerCase()}::${role.trim().toLowerCase()}`;
}

function isTrackerEntry(value: unknown): value is TrackerEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TrackerEntry>;
  return (
    typeof candidate.key === "string" &&
    (candidate.applicationId === undefined || typeof candidate.applicationId === "string") &&
    typeof candidate.company === "string" &&
    typeof candidate.role === "string" &&
    typeof candidate.source === "string" &&
    typeof candidate.status === "string" && isAppStatus(candidate.status) &&
    typeof candidate.appliedAt === "string" &&
    typeof candidate.lastUpdate === "string" &&
    Array.isArray(candidate.history)
  );
}

async function readTrackerState(config: HenryConfig): Promise<TrackerState> {
  try {
    const raw = JSON.parse(await fs.readFile(config.jobTrackerPath, "utf8")) as Partial<TrackerState>;
    const entries = Array.isArray(raw.entries) ? raw.entries.filter(isTrackerEntry) : [];
    return { entries };
  } catch {
    return { entries: [] };
  }
}

async function writeTrackerState(config: HenryConfig, state: TrackerState): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${config.jobTrackerPath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, config.jobTrackerPath);
  await fs.chmod(config.jobTrackerPath, 0o600).catch(() => undefined);
  // The .md is the artifact Luvish actually reads — no restrictive mode, same as cover letters / linkedin drafts.
  await fs.writeFile(config.jobTrackerMarkdownPath, renderMarkdown(state), "utf8");
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Serializes the canonical ledger's read-modify-write transaction across Henry processes. */
async function withTrackerLock<T>(config: HenryConfig, operation: () => Promise<T>): Promise<T> {
  await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const lockPath = `${config.jobTrackerPath}.lock`;
  const token = `${process.pid}:${randomUUID()}`;
  let acquired = false;
  for (let attempt = 0; attempt < 200 && !acquired; attempt += 1) {
    try {
      await fs.writeFile(lockPath, token, { encoding: "utf8", mode: 0o600, flag: "wx" });
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      let observedToken = "";
      try {
        const [holder, stat] = await Promise.all([fs.readFile(lockPath, "utf8"), fs.stat(lockPath)]);
        observedToken = holder;
        const holderPid = Number(holder.split(":", 1)[0]);
        stale = Number.isFinite(holderPid)
          ? holderPid !== process.pid && !isPidAlive(holderPid)
          : Date.now() - stat.mtimeMs > 30_000;
      } catch { /* The holder may be releasing the lock. */ }
      if (stale) await quarantineStaleLock(lockPath, observedToken);
      else await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!acquired) throw new Error("Timed out waiting to update the canonical job tracker");
  try { return await operation(); }
  finally {
    const holder = await fs.readFile(lockPath, "utf8").catch(() => "");
    if (holder === token) await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Claims stale-lock breaking with a fixed hard-link quarantine. Only one contender can
 * create that link; inode verification ensures it cannot unlink a fresh replacement lock.
 */
async function quarantineStaleLock(lockPath: string, observedToken: string): Promise<void> {
  const quarantinePath = `${lockPath}.stale-break`;
  try {
    await fs.link(lockPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const stat = await fs.stat(quarantinePath).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > 30_000) await fs.rm(quarantinePath, { force: true }).catch(() => undefined);
      return;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const [quarantinedToken, currentToken, quarantinedStat, currentStat] = await Promise.all([
      fs.readFile(quarantinePath, "utf8"),
      fs.readFile(lockPath, "utf8").catch(() => ""),
      fs.stat(quarantinePath),
      fs.stat(lockPath).catch(() => undefined),
    ]);
    if (quarantinedToken === observedToken && currentToken === observedToken && currentStat
      && currentStat.dev === quarantinedStat.dev && currentStat.ino === quarantinedStat.ino) {
      await fs.unlink(lockPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  } finally {
    await fs.rm(quarantinePath, { force: true }).catch(() => undefined);
  }
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "/").trim() || "—";
}

/** Renders the canonical ledger: a table sorted by last-update desc, plus a per-application history section. */
export function renderMarkdown(state: TrackerState, now: Date = new Date()): string {
  const sorted = [...state.entries].sort((a, b) => (b.lastUpdate || "").localeCompare(a.lastUpdate || ""));
  const lines: string[] = ["# Job Application Tracker", "", `_Last regenerated: ${now.toISOString()}_`, ""];
  if (sorted.length === 0) {
    lines.push(
      "No applications tracked yet. Run `npx tsx src/cli.ts mailwatch backfill --days 30` to seed this ledger from recent inbox history, or wait for the next scheduled mailwatch check.",
      "",
    );
    return `${lines.join("\n")}\n`;
  }
  lines.push("| Company | Role | Source | Current status | Pending action | Applied | Last update |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const entry of sorted) {
    lines.push(
      `| ${escapeCell(entry.company)} | ${escapeCell(entry.role)} | ${escapeCell(entry.source)} | ${escapeCell(entry.status)} | ${escapeCell(entry.pendingAction ?? "")} | ${escapeCell(entry.appliedAt)} | ${escapeCell(entry.lastUpdate)} |`,
    );
  }
  lines.push("", "## History", "");
  for (const entry of sorted) {
    lines.push(`### ${entry.company} — ${entry.role}`);
    for (const item of entry.history) {
      const action = item.pendingAction ? ` — pending **${item.pendingAction.replace(/_/g, " ")}**` : "";
      lines.push(`- ${escapeCell(item.dateText)} — **${item.status}**${action} — "${item.subject}" (${entry.source}, recorded ${item.recordedAt})`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Applies `APP|...` lines (from either `check()`'s live scan or `backfill()`'s wider sweep) to
 * the canonical ledger, then regenerates `job-tracker.md`. Dedupe is via the tracker's own
 * history — not mailwatch's `seenIds` — so a re-seen email for a company+role at its current
 * status is a no-op. APP_STATUSES is progression-ordered, and status only ever moves FORWARD
 * along it (or into a terminal outcome — rejected/offer are always accepted): a lower status
 * is a late/out-of-order email that joins the history silently, with no notification and no
 * headline change. `options.backfill` stamps every recorded history entry so digests can tell
 * seeded history from live news. Re-reads the state file immediately before writing (the
 * reminders-store clobber lesson).
 */
export async function updateTracker(config: HenryConfig, lines: string[], options: { backfill?: boolean } = {}): Promise<TrackerUpdateResult> {
  const parsed = lines.map(parseAppLine).filter((item): item is ParsedApp => item !== undefined);
  return recordTrackerEvents(config, parsed, options);
}

/** Records one trusted structured event without converting it to or reparsing model-oriented APP text. */
export async function recordTrackerEvent(config: HenryConfig, event: StructuredTrackerEvent, options: { backfill?: boolean } = {}): Promise<TrackerUpdateResult> {
  return recordTrackerEvents(config, [event], options);
}

/** Atomically applies structured evidence events to the canonical ledger. */
export async function recordTrackerEvents(config: HenryConfig, input: StructuredTrackerEvent[], options: { backfill?: boolean } = {}): Promise<TrackerUpdateResult> {
  const parsed = input.map((event): ParsedApp | undefined => {
    const applicationId = event.applicationId?.trim();
    const company = event.company.trim();
    const role = event.role.trim();
    const source = event.source.trim();
    const subject = event.subject.trim();
    if (!company || !role || !source || !subject || !isAppStatus(event.status)) return undefined;
    return { ...event, ...(applicationId ? { applicationId } : {}), company, role, source, subject, dateText: event.dateText.trim() || "unknown" };
  }).filter((item): item is ParsedApp => item !== undefined);
  if (parsed.length === 0) return { notifications: [], created: 0, changed: 0, events: [] };

  return withTrackerLock(config, async () => {
  const state = await readTrackerState(config);
  const notifications: string[] = [];
  const events: TrackerAppEvent[] = [];
  let created = 0;
  let changed = 0;
  // Silent history appends (regressions, appliedAt backfills) don't count as
  // created/changed but still have to be persisted.
  let dirty = false;
  const now = new Date().toISOString();
  const stamp = (app: ParsedApp): TrackerHistoryEntry => ({
    status: app.status, dateText: app.dateText, subject: app.subject, recordedAt: now,
    ...(app.pendingAction ? { pendingAction: app.pendingAction } : {}),
    ...(options.backfill ? { backfill: true } : {}),
  });

  for (const app of parsed) {
    let key = entryKey(app.company, app.role, app.applicationId);
    const sameCompanyRole = state.entries.filter((candidate) => entryKey(candidate.company, candidate.role) === entryKey(app.company, app.role));
    let entry = state.entries.find((candidate) => candidate.key === key);
    if (!entry && app.applicationId) {
      const legacyMatches = sameCompanyRole.filter((candidate) => !candidate.applicationId);
      const identifiedMatches = sameCompanyRole.filter((candidate) => candidate.applicationId);
      if (legacyMatches.length === 1 && identifiedMatches.length === 0) {
        // Deterministically upgrade the sole legacy email record instead of duplicating it
        // when a persisted Henry submission is reconciled later.
        entry = legacyMatches[0];
        entry.applicationId = app.applicationId;
        entry.key = key;
        dirty = true;
      }
    } else if (!entry && !app.applicationId) {
      const browserMatches = sameCompanyRole.filter((candidate) => candidate.applicationId);
      if (browserMatches.length === 1) {
        // Email has no draft ID. One browser record is unambiguous; two are not, so the
        // legacy company-role fallback remains a separate record in the ambiguous case.
        entry = browserMatches[0];
        key = entry.key;
      }
    }
    if (!entry) {
      state.entries.push({
        key, ...(app.applicationId ? { applicationId: app.applicationId } : {}), company: app.company, role: app.role, source: app.source, status: app.status,
        // appliedAt only ever comes from an "applied" email (audit M20): an entry first
        // seen through a rejection must not claim the rejection's date as its application
        // date. A later applied confirmation backfills it below.
        appliedAt: app.status === "applied" ? app.dateText : "",
        lastUpdate: now,
        ...(app.pendingAction ? { pendingAction: app.pendingAction } : {}),
        history: [stamp(app)],
      });
      created += 1;
      if (NOTIFY_STATUSES.has(app.status)) notifications.push(`📋 Application update: ${app.company} ${app.role} → ${app.status}`);
      events.push({ ...(app.applicationId ? { applicationId: app.applicationId } : {}), company: app.company, role: app.role, status: app.status, subject: app.subject, dateText: app.dateText, isNew: true, ...(app.pendingAction ? { pendingAction: app.pendingAction } : {}) });
      continue;
    }
    const duplicate = entry.history.some((item) => item.status === app.status
      && (app.applicationId !== undefined || (item.subject === app.subject && item.pendingAction === app.pendingAction)));
    if (duplicate) continue; // already recorded — no-op, no notify
    const advances = APP_STATUSES.indexOf(app.status) > APP_STATUSES.indexOf(entry.status)
      || app.status === "rejected" || app.status === "offer";
    if (!advances) {
      // Progression guard (audit M16): a lower status is a late/re-scanned email —
      // keep it for the audit trail, but never walk "interview" back to "viewed"
      // and never ping Luvish about old news.
      entry.history.push(stamp(app));
      if (app.pendingAction) entry.pendingAction = app.pendingAction;
      if (app.status === "applied" && !entry.appliedAt) entry.appliedAt = app.dateText; // first applied seen
      if (app.pendingAction) {
        entry.lastUpdate = now;
        changed += 1;
        notifications.push(`📋 Application action needed: ${app.company} ${app.role} → ${app.pendingAction.replace(/_/g, " ")}`);
        events.push({ ...(app.applicationId ? { applicationId: app.applicationId } : {}), company: app.company, role: app.role, status: app.status, subject: app.subject, dateText: app.dateText, isNew: false, pendingAction: app.pendingAction });
      }
      dirty = true;
      continue;
    }
    entry.company = app.company;
    entry.role = app.role;
    entry.source = app.source || entry.source;
    entry.status = app.status;
    entry.lastUpdate = now;
    entry.history.push(stamp(app));
    entry.pendingAction = app.pendingAction;
    changed += 1;
    if (NOTIFY_STATUSES.has(app.status)) notifications.push(`📋 Application update: ${app.company} ${app.role} → ${app.status}`);
    events.push({ ...(app.applicationId ? { applicationId: app.applicationId } : {}), company: app.company, role: app.role, status: app.status, subject: app.subject, dateText: app.dateText, isNew: false, ...(app.pendingAction ? { pendingAction: app.pendingAction } : {}) });
  }

  if (created > 0 || changed > 0 || dirty) await writeTrackerState(config, state);
  return { notifications, created, changed, events };
  });
}

interface SubmittedApplicationRecord {
  id: string;
  status: string;
  submittedAt?: string;
  posting?: { company?: string; title?: string; source?: string };
}

export interface TrackerReconciliationResult extends TrackerUpdateResult {
  submittedRecords: number;
}

/** Replays locally persisted submitted drafts into the tracker. No provider or network is used. */
export async function reconcileSubmittedApplications(config: HenryConfig): Promise<TrackerReconciliationResult> {
  let records: unknown;
  try { records = JSON.parse(await fs.readFile(config.jobApplicationsPath, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { notifications: [], created: 0, changed: 0, events: [], submittedRecords: 0 };
    throw error;
  }
  if (!Array.isArray(records)) throw new Error("Job application store is not an array; cannot reconcile tracker");
  const submitted = (records as SubmittedApplicationRecord[]).filter((record) => record?.status === "submitted"
    && typeof record.id === "string" && typeof record.submittedAt === "string"
    && typeof record.posting?.company === "string" && typeof record.posting?.title === "string"
    && typeof record.posting?.source === "string").sort((a, b) => a.id.localeCompare(b.id));
  const update = await recordTrackerEvents(config, submitted.map((record) => ({
    applicationId: record.id,
    company: record.posting!.company!,
    role: record.posting!.title!,
    source: record.posting!.source!,
    status: "applied",
    dateText: record.submittedAt!,
    subject: `Henry submitted application ${record.id}`,
  })));
  return { ...update, submittedRecords: submitted.length };
}

/** Read-only summary for `henry mailwatch tracker` — never writes. */
export async function trackerSummary(config: HenryConfig): Promise<TrackerSummary> {
  const state = await readTrackerState(config);
  const byStatus = Object.fromEntries(APP_STATUSES.map((status) => [status, 0])) as Record<AppStatus, number>;
  for (const entry of state.entries) byStatus[entry.status] += 1;
  return { jsonPath: config.jobTrackerPath, markdownPath: config.jobTrackerMarkdownPath, total: state.entries.length, byStatus };
}

export interface TrackerDigest {
  date: string;
  newlyIndexed: number;
  indexedUpdates: number;
  indexedJobRecords: number;
  byStatus: Record<AppStatus, number>;
  /** One compact Telegram-ready line — "just the index", no per-application detail. */
  line: string;
}

/** recordedAt timestamps come from Henry's own clock, so local-day bucketing is honest. */
function isLocalDay(iso: string, now: Date): boolean {
  const stamp = new Date(iso);
  return stamp.getFullYear() === now.getFullYear() && stamp.getMonth() === now.getMonth() && stamp.getDate() === now.getDate();
}

/**
 * The scheduled "job index": counts only, computed locally from recordedAt evidence in the
 * tracker ledger — zero provider spend. It describes indexing activity, not event dates.
 */
export async function trackerDigest(config: HenryConfig, now: Date = new Date()): Promise<TrackerDigest> {
  const state = await readTrackerState(config);
  const byStatus = Object.fromEntries(APP_STATUSES.map((status) => [status, 0])) as Record<AppStatus, number>;
  let newlyIndexed = 0;
  let indexedUpdates = 0;
  for (const entry of state.entries) {
    byStatus[entry.status] += 1;
    for (const item of entry.history) {
      // Backfilled entries were RECORDED today but describe weeks-old inbox history —
      // counting them would make a seeding sweep read as a monster application day.
      if (item.backfill) continue;
      if (!isLocalDay(item.recordedAt, now)) continue;
      if (item.status === "applied") newlyIndexed += 1;
      else indexedUpdates += 1;
    }
  }
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const statusBits = APP_STATUSES.filter((status) => byStatus[status] > 0).map((status) => `${status} ${byStatus[status]}`).join(" · ");
  const line = `📊 Job index — newly indexed: ${newlyIndexed} confirmation record${newlyIndexed === 1 ? "" : "s"}, ${indexedUpdates} status update${indexedUpdates === 1 ? "" : "s"} · ${state.entries.length} indexed job records (${statusBits || "none yet"})`;
  return { date, newlyIndexed, indexedUpdates, indexedJobRecords: state.entries.length, byStatus, line };
}
