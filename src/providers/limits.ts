import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProviderName } from "../types.ts";

/**
 * Provider limit ledger — "when Claude runs out of tokens, switch to Codex, and vice versa".
 *
 * Two jobs, kept apart from ProviderRunner so both are testable without spawning a CLI:
 *
 *  1. CLASSIFICATION — decide whether a failed run failed because the subscription is
 *     exhausted (a LIMIT) rather than because the work itself broke. Deliberately
 *     conservative: an ordinary stack trace, a missing file, a bad flag, or a context-window
 *     overflow must NEVER be read as a limit, because a false positive parks a healthy CLI
 *     for 45 minutes.
 *  2. COOLDOWN — remember that a provider is down until its reset time (parsed from the CLI's
 *     own wording when it prints one, otherwise now + 45 minutes), in memory AND in
 *     `data/provider-limits.json` so a daemon restart does not forget and immediately walk
 *     back into the same wall.
 *
 * Nothing here spawns, reads env, or talks to the network.
 */

/** Ledger filename inside `config.dataDir`. */
export const LIMIT_LEDGER_FILE = "provider-limits.json";
/** No reset time in the CLI's message → assume this long (MASTER_PLAN-style conservative default). */
export const DEFAULT_LIMIT_COOLDOWN_MS = 45 * 60 * 1000;
/** A logged-out CLI is unavailable, not limited — re-login is a human action that can land any second. */
export const AUTH_COOLDOWN_MS = 5 * 60 * 1000;
/** Binary missing / spawn failed. */
export const UNAVAILABLE_COOLDOWN_MS = 10 * 60 * 1000;
/**
 * Clamp: a mis-parsed reset must never park a provider for days. 24h is deliberate — it is the
 * furthest a bare wall-clock reset ("resets 2:30am") can legitimately be, so every clock form is
 * honored exactly while a weekly/monthly wall self-corrects with one wasted attempt a day later.
 */
export const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Clamp: a reset that parses to "already past" still gets a real pause. */
export const MIN_COOLDOWN_MS = 60 * 1000;
/**
 * Limit notices are TERSE. Stdout is only trusted as evidence when the whole reply is shorter
 * than this — the same guard `isAuthFailureResponse` uses — so a long, normal answer that merely
 * DISCUSSES rate limiting is never mistaken for hitting one.
 */
export const LIMIT_RESPONSE_MAX_CHARS = 400;

/**
 * Why a provider is parked.
 * - `limit`      — quota/usage/rate exhausted. HARD: worth failing fast on, because trying again
 *                  before the reset is guaranteed to fail.
 * - `auth`       — CLI logged out. SOFT: skipped when picking a failover target, but never blocks
 *                  a last-resort attempt (the operator may have just re-logged in).
 * - `unavailable`— binary missing / spawn error. SOFT, same reasoning.
 */
export type LimitKind = "limit" | "auth" | "unavailable";

export interface LimitDetection {
  limited: boolean;
  kind?: LimitKind;
  /** Name of the pattern that matched — carried into the activity log so a false positive is diagnosable. */
  matched?: string;
  /** Short human reason (the matched line, trimmed) for status surfaces. */
  reason?: string;
  /** Best-effort reset instant parsed out of the CLI's own wording (ISO). Absent when it printed none. */
  resetAt?: string;
}

export interface LimitEntry {
  /** ISO instant the provider becomes usable again. */
  until: string;
  reason: string;
  kind: LimitKind;
  /** ISO instant the cooldown was recorded. */
  since: string;
  /** True when `until` came from the CLI's own wording rather than the fallback window. */
  parsedReset?: boolean;
}

export type LimitState = Partial<Record<ProviderName, LimitEntry>>;

const PROVIDERS: ProviderName[] = ["claude", "codex"];

interface LimitPattern {
  name: string;
  pattern: RegExp;
  /** Weak patterns are vetoed by EXCLUSIONS (they contain the word "limit" in innocent contexts too). */
  weak?: boolean;
  /** Extra evidence required elsewhere in the text before the match counts. */
  companion?: RegExp;
}

/**
 * Limit signatures across both CLIs, case-insensitive.
 *
 * claude: "Claude usage limit reached · resets 2:30am", "5-hour limit reached",
 *         "You've reached your usage limit", rate_limit_error, 429.
 * codex:  "You've hit your usage limit", "quota exceeded", "Too Many Requests", 429.
 *
 * STRONG entries stand on their own. WEAK entries only say "limit" and are vetoed by
 * EXCLUSIONS, which is what keeps a context-window overflow or a concurrency cap from
 * parking a perfectly healthy subscription.
 */
const LIMIT_PATTERNS: LimitPattern[] = [
  { name: "usage-limit", pattern: /\busage[\s_-]?limit\b/i },
  { name: "session-limit", pattern: /\bsession[\s_-]?limit\b/i },
  // Separator is MANDATORY and corroboration is REQUIRED: a stack frame in the user's own code
  // (`rateLimit(...)`, `rate_limit.ts`) must never be mistaken for the API telling us to slow down.
  {
    name: "rate-limit",
    pattern: /\brate[\s_-]limit(?:ed|ing|s)?\b/i,
    companion: /\b(?:exceeded|reached|hit|too many|retry|resets?|throttl\w*|429|slow down|try again|wait)\b/i,
  },
  { name: "too-many-requests", pattern: /\btoo many requests\b/i },
  { name: "quota-exhausted", pattern: /\bquota\b[^\n]{0,40}?\b(?:exceeded|exhausted|reached|used up|depleted|remaining)\b/i },
  { name: "quota-exhausted", pattern: /\b(?:exceeded|exhausted|out of|ran out of|no more)\b[^\n]{0,24}?\bquota\b/i },
  { name: "out-of-credits", pattern: /\b(?:out of|insufficient|no remaining)\s+(?:credits?|balance)\b/i },
  { name: "out-of-credits", pattern: /\bcredit balance is too low\b/i },
  { name: "plan-exhausted", pattern: /\b(?:upgrade|resets?)\b[^\n]{0,40}?\b(?:to keep going|to continue using)\b/i },
  { name: "http-429", pattern: /(?:^|[^\d.])429(?:[^\d]|$)/, companion: /\b(?:rate|limit|quota|retry|throttl|too many)\b/i },
  { name: "limit-reached", pattern: /\blimits?\s+(?:reached|exceeded|hit|met)\b/i, weak: true },
  { name: "reached-limit", pattern: /\b(?:reached|hit|used up|exhausted)\b[^\n]{0,24}?\blimits?\b/i, weak: true },
  { name: "window-limit", pattern: /\b\d+\s*-?\s*(?:hour|hr|day|week|month)(?:ly)?\s+limit\b/i, weak: true },
  { name: "window-limit", pattern: /\b(?:hourly|daily|weekly|monthly)\s+limit\b/i, weak: true },
];

/**
 * Innocent uses of the word "limit". Any of these veto a WEAK match — a prompt that blew the
 * context window, a concurrency cap, or an OS ulimit is a bug to fix, not a subscription to wait out.
 */
const EXCLUSIONS: RegExp[] = [
  /\bcontext\s+(?:window|length|limit)\b/i,
  /\bmaximum\s+context\b/i,
  /\b(?:token|character|char|line|size|file|memory|disk|concurrency|depth|recursion|redirect|retry)\s+limit\b/i,
  /\bulimit\b/i,
  /\bprompt is too long\b/i,
  /\binput (?:is )?too long\b/i,
];

function matchedLine(text: string, pattern: RegExp): string {
  const match = pattern.exec(text);
  if (!match) return "";
  const before = text.lastIndexOf("\n", match.index);
  const afterIndex = text.indexOf("\n", match.index);
  const line = text.slice(before + 1, afterIndex === -1 ? undefined : afterIndex).trim();
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/**
 * Classifies one blob of CLI output as a limit or not. Pure — pass `now` for deterministic
 * reset math. Conservative by construction (see LIMIT_PATTERNS/EXCLUSIONS).
 */
export function classifyLimit(text: string, now: Date = new Date()): LimitDetection {
  const body = (text || "").trim();
  if (!body) return { limited: false };
  const excluded = EXCLUSIONS.some((rule) => rule.test(body));
  for (const entry of LIMIT_PATTERNS) {
    if (entry.weak && excluded) continue;
    if (!entry.pattern.test(body)) continue;
    if (entry.companion && !entry.companion.test(body)) continue;
    const resetAt = parseResetAt(body, now);
    return {
      limited: true,
      kind: "limit",
      matched: entry.name,
      reason: matchedLine(body, entry.pattern) || entry.name,
      ...(resetAt ? { resetAt } : {}),
    };
  }
  return { limited: false };
}

/**
 * Classifies a finished run. Evidence is the error text plus stderr, and stdout ONLY when the
 * whole reply is short (limit notices are terse). Exit code is deliberately NOT required: both
 * CLIs have been observed printing a limit notice and exiting 0, exactly like the logged-out case.
 */
export function detectRunLimit(
  result: { response: string; error?: string; events?: { stream: string; text: string }[] },
  now: Date = new Date(),
): LimitDetection {
  const stderr = (result.events ?? []).filter((event) => event.stream !== "stdout").map((event) => event.text).join("\n");
  const response = (result.response || "").trim();
  const text = [result.error ?? "", stderr, response.length < LIMIT_RESPONSE_MAX_CHARS ? response : ""]
    .filter(Boolean)
    .join("\n");
  return classifyLimit(text, now);
}

/**
 * True when the failure was "that CLI isn't installed / couldn't be spawned" rather than work
 * failing. Counts as UNAVAILABLE (soft cooldown): the dispatcher stops picking it as a failover
 * target for a few minutes instead of respawning ENOENT on every job.
 */
export function detectMissingBinary(text: string | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return lower.includes("enoent")
    || lower.includes("command not found")
    || lower.includes("no such file or directory")
    || lower.includes("not found in $path")
    || lower.includes("eaccess")
    || lower.includes("permission denied");
}

const UNITS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
};

/** Words that introduce a reset time; a clock/duration is only read from the window right after one. */
const RESET_KEYWORD = /\b(?:resets?|resetting|reset at|renews?|try again|retry|available again|come back|wait until|back at)\b/i;
const RESET_WINDOW_CHARS = 60;

const ISO_TIME = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/;
const RELATIVE = /\bin\s+(?:about\s+|~\s*)?(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i;
const RETRY_AFTER = /\bretry[-\s]?after[:\s]+(\d+)\b/i;
const CLOCK_12H = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
const CLOCK_24H = /\b(\d{1,2}):(\d{2})\b/;

/** Next local wall-clock occurrence of hh:mm strictly after `now` (today if still ahead, else tomorrow). */
function nextClockTime(now: Date, hours: number, minutes: number): Date {
  const candidate = new Date(now);
  candidate.setHours(hours, minutes, 0, 0);
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

/**
 * Best-effort reset instant out of a CLI limit notice. Understands
 * "resets 2:30am" / "will reset at 15:00" (next local occurrence — a printed timezone name is
 * IGNORED, the CLIs print local time), "try again in 20 minutes", "Retry-After: 3600", and a bare
 * ISO timestamp. Returns undefined when the message names no time — the caller then applies the
 * 45-minute fallback. Clamped to [now+1min, now+12h] so a mis-parse can't bench a provider for days.
 */
export function parseResetAt(text: string, now: Date = new Date()): string | undefined {
  const body = (text || "").trim();
  if (!body) return undefined;

  const iso = ISO_TIME.exec(body);
  if (iso) {
    const parsed = new Date(iso[0].replace(" ", "T"));
    if (Number.isFinite(parsed.getTime()) && parsed.getTime() > now.getTime()) return clamp(parsed, now).toISOString();
  }

  const retryAfter = RETRY_AFTER.exec(body);
  if (retryAfter) return clamp(new Date(now.getTime() + Number(retryAfter[1]) * 1000), now).toISOString();

  const keyword = RESET_KEYWORD.exec(body);
  if (!keyword) return undefined;
  const window = body.slice(keyword.index, keyword.index + RESET_WINDOW_CHARS);

  const relative = RELATIVE.exec(window);
  if (relative) {
    const unit = UNITS[relative[2].toLowerCase()];
    if (unit) return clamp(new Date(now.getTime() + Number(relative[1]) * unit), now).toISOString();
  }

  const clock12 = CLOCK_12H.exec(window);
  if (clock12) {
    const raw = Number(clock12[1]);
    if (raw >= 1 && raw <= 12) {
      const minutes = clock12[2] ? Number(clock12[2]) : 0;
      const pm = clock12[3].toLowerCase() === "pm";
      const hours = pm ? (raw === 12 ? 12 : raw + 12) : (raw === 12 ? 0 : raw);
      if (minutes < 60) return clamp(nextClockTime(now, hours, minutes), now).toISOString();
    }
  }

  const clock24 = CLOCK_24H.exec(window);
  if (clock24) {
    const hours = Number(clock24[1]);
    const minutes = Number(clock24[2]);
    if (hours < 24 && minutes < 60) return clamp(nextClockTime(now, hours, minutes), now).toISOString();
  }
  return undefined;
}

function clamp(candidate: Date, now: Date): Date {
  const floor = now.getTime() + MIN_COOLDOWN_MS;
  const ceiling = now.getTime() + MAX_COOLDOWN_MS;
  const value = candidate.getTime();
  if (!Number.isFinite(value) || value < floor) return new Date(floor);
  if (value > ceiling) return new Date(ceiling);
  return candidate;
}

function isProvider(value: unknown): value is ProviderName {
  return value === "claude" || value === "codex";
}

function readEntry(value: unknown): LimitEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const until = typeof record.until === "string" ? record.until : undefined;
  if (!until || !Number.isFinite(new Date(until).getTime())) return undefined;
  const kind = record.kind === "auth" || record.kind === "unavailable" ? record.kind : "limit";
  return {
    until,
    kind,
    reason: typeof record.reason === "string" ? record.reason : "provider limited",
    since: typeof record.since === "string" ? record.since : until,
    ...(record.parsedReset === true ? { parsedReset: true } : {}),
  };
}

/**
 * The cooldown ledger. In-memory for the hot path, read-through/write-through to
 * `data/provider-limits.json` so a restarted daemon (or a second runner instance in the same
 * process) sees the same cooldowns. Never throws: an unreadable or corrupt file reads as "nothing
 * is limited", which fails OPEN — the worst case is one wasted attempt, never a lockout.
 */
export class ProviderLimitLedger {
  private cache: LimitState = {};

  constructor(private readonly filePath: string) {
    this.cache = this.load();
  }

  get path(): string { return this.filePath; }

  private load(): LimitState {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...this.cache };
      const state: LimitState = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!isProvider(key)) continue;
        const entry = readEntry(value);
        if (entry) state[key] = entry;
      }
      this.cache = state;
      return { ...state };
    } catch {
      // Missing file on first run is the common case; keep whatever memory holds.
      return { ...this.cache };
    }
  }

  private persist(state: LimitState): void {
    this.cache = state;
    try {
      mkdirSync(path.dirname(path.resolve(this.filePath)), { recursive: true, mode: 0o700 });
      writeFileSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // A read-only data dir must not break dispatch — memory still carries the cooldown.
    }
  }

  /** Live cooldowns, expired entries pruned (and pruned from disk when anything actually expired). */
  state(now: Date = new Date()): LimitState {
    const loaded = this.load();
    const live: LimitState = {};
    let expired = false;
    for (const provider of PROVIDERS) {
      const entry = loaded[provider];
      if (!entry) continue;
      if (new Date(entry.until).getTime() > now.getTime()) live[provider] = entry;
      else expired = true;
    }
    if (expired) this.persist(live); else this.cache = live;
    return live;
  }

  entry(provider: ProviderName, now: Date = new Date()): LimitEntry | undefined {
    return this.state(now)[provider];
  }

  /** True when the provider carries no live cooldown of any kind — i.e. it's a valid failover target. */
  available(provider: ProviderName, now: Date = new Date()): boolean {
    return this.entry(provider, now) === undefined;
  }

  /**
   * True only for a HARD (`limit`) cooldown: retrying before the reset is pointless, so the runner
   * may refuse without spawning. Soft `auth`/`unavailable` cooldowns deliberately return false —
   * they deprioritize a provider but never block a last-resort attempt.
   */
  blocked(provider: ProviderName, now: Date = new Date()): boolean {
    return this.entry(provider, now)?.kind === "limit";
  }

  /** Parks `provider` until its parsed reset (or now + the kind's default window). */
  markLimited(provider: ProviderName, detection: LimitDetection, now: Date = new Date()): LimitEntry {
    const kind: LimitKind = detection.kind ?? "limit";
    const fallbackMs = kind === "auth" ? AUTH_COOLDOWN_MS : kind === "unavailable" ? UNAVAILABLE_COOLDOWN_MS : DEFAULT_LIMIT_COOLDOWN_MS;
    const parsed = detection.resetAt ? new Date(detection.resetAt) : undefined;
    const usable = parsed && Number.isFinite(parsed.getTime()) && parsed.getTime() > now.getTime();
    const until = usable ? clamp(parsed as Date, now) : new Date(now.getTime() + fallbackMs);
    const entry: LimitEntry = {
      until: until.toISOString(),
      reason: detection.reason || (kind === "auth" ? "provider session logged out" : "provider limit reached"),
      kind,
      since: now.toISOString(),
      ...(usable ? { parsedReset: true } : {}),
    };
    const state = { ...this.state(now), [provider]: entry };
    this.persist(state);
    return entry;
  }

  /** Clears a provider's cooldown — a successful run is proof it is back. */
  clear(provider?: ProviderName, now: Date = new Date()): void {
    const state = this.state(now);
    if (provider === undefined) { this.persist({}); return; }
    if (!state[provider]) return;
    delete state[provider];
    this.persist(state);
  }
}

/**
 * Process-wide default ledger for status surfaces. ProviderRunner points this at its own
 * `dataDir/provider-limits.json` on construction, so `:status` can read provider health without
 * reaching through the agent for a runner instance.
 */
let defaultPath: string | undefined;
let defaultLedger: ProviderLimitLedger | undefined;

/** Points the module-level helpers at a ledger file (idempotent for the same path). */
export function configureProviderLimits(filePath: string): void {
  const resolved = path.resolve(filePath);
  if (defaultPath === resolved) return;
  defaultPath = resolved;
  defaultLedger = undefined;
}

/** The configured ledger, or undefined when nothing has configured one yet. */
export function providerLimitLedger(): ProviderLimitLedger | undefined {
  if (!defaultPath) return undefined;
  defaultLedger ||= new ProviderLimitLedger(defaultPath);
  return defaultLedger;
}

/** STATUS API: is this CLI usable right now (no live cooldown)? Unknown/unconfigured reads as available. */
export function providerAvailable(provider: ProviderName, now: Date = new Date()): boolean {
  return providerLimitLedger()?.available(provider, now) ?? true;
}

/** STATUS API: `{claude?: {until, reason, kind, since}, codex?: {...}}` — empty when nothing is limited. */
export function limitState(now: Date = new Date()): LimitState {
  return providerLimitLedger()?.state(now) ?? {};
}

/** Operator escape hatch (e.g. after a manual re-login): drop one or all cooldowns. */
export function clearProviderLimit(provider?: ProviderName): void {
  providerLimitLedger()?.clear(provider);
}

/** Earliest ISO instant at which any parked provider comes back, or undefined when none is parked. */
export function earliestReset(state: LimitState): string | undefined {
  const times = PROVIDERS.map((provider) => state[provider]?.until).filter((value): value is string => Boolean(value));
  if (!times.length) return undefined;
  return times.reduce((earliest, value) => (new Date(value).getTime() < new Date(earliest).getTime() ? value : earliest));
}

/**
 * One-line operator-grade explanation for "everything is parked" — the message a caller sees
 * instead of a doomed spawn. Includes each provider's reason and reset, plus the earliest reset
 * so the human knows exactly how long to wait.
 */
export function describeLimited(state: LimitState, providers: ProviderName[] = PROVIDERS): string {
  const parts = providers
    .map((provider) => {
      const entry = state[provider];
      return entry ? `${provider} (${entry.reason}) until ${entry.until}` : undefined;
    })
    .filter((value): value is string => Boolean(value));
  if (!parts.length) return "no provider was available";
  const earliest = earliestReset(state);
  const subject = parts.length > 1 ? "Both provider CLIs are out of quota" : "The provider CLI is out of quota";
  return `${subject}: ${parts.join("; ")}.${earliest ? ` Earliest reset ${earliest}.` : ""}`;
}
