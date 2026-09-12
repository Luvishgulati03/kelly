import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { ActivityKind, DispatchTier, ProviderEvent, ProviderName, RunResult } from "../types.ts";
import { safeEnvironment } from "../util/env.ts";
import path from "node:path";
import { SessionManager, sessionArgs } from "./session.ts";
import { AdmissionController, sharedAdmissionController } from "../orchestration/admission.ts";
import { notifyReminder, type ReminderNotifier } from "../reminders/service.ts";
import { readSettings } from "../util/settings.ts";
import {
  LIMIT_LEDGER_FILE,
  ProviderLimitLedger,
  configureProviderLimits,
  describeLimited,
  detectMissingBinary,
  detectRunLimit,
  type LimitDetection,
  type LimitState,
} from "./limits.ts";

export interface RunOptions {
  /**
   * Names a long-lived conversation surface (e.g. "repl", "dashboard-ask").
   * When set, the run resumes that surface's provider session instead of a
   * cold ephemeral spawn (latency §11.5 #2). Callers that set this SHOULD
   * send slim prompts on resumed turns — ask `acquireSession` first.
   */
  surface?: string;
  /** Precomputed session from acquireSession() — lets the caller build a slim prompt for resumed turns. */
  session?: { id: string; fresh: boolean; provider: ProviderName };
  provider?: ProviderName;
  cwd?: string;
  role?: string;
  readOnly?: boolean;
  /** MASTER_PLAN §11.1 tier; absent keeps the configured default models. */
  tier?: DispatchTier;
  /** Time spent assembling prompt/memory/RAG before this provider is admitted. */
  promptBuildMs?: number;
  /** Wall-clock envelope per provider attempt (§7). */
  timeoutMs?: number;
  onEvent?: (event: ProviderEvent) => void;
}

/** Default wall-clock envelope: 5 minutes (MASTER_PLAN §7). */
export const DEFAULT_ENVELOPE_MS = 300_000;
/** Grace period between SIGTERM and SIGKILL. */
export const ENVELOPE_KILL_GRACE_MS = 10_000;
/** Fast delegated worker for t0 triage work. Config may override it per deployment. */
export const CODEX_T0_MODEL = "gpt-5.5";
export const ENVELOPE_TIMEOUT_ERROR = "envelope timeout";
/** Waiting longer than this in the admission queue is worth recording. */
export const QUEUE_NOTICE_MS = 5_000;
export const CODEX_RESUME_TAILOR_MODEL = "gpt-5.5";
export const CODEX_APPLICATION_REVIEW_MODEL = "gpt-5.5";
export const CODEX_APPLICATION_MANAGER_MODEL = "gpt-5.6-sol";
const CODEX_JOB_ROLE_MODELS = {
  "resume-tailor": { key: "codexResumeTailorModel", fallback: CODEX_RESUME_TAILOR_MODEL },
  "application-review": { key: "codexApplicationReviewModel", fallback: CODEX_APPLICATION_REVIEW_MODEL },
  "application-manager": { key: "codexApplicationManagerModel", fallback: CODEX_APPLICATION_MANAGER_MODEL },
} as const;
type CodexJobRole = keyof typeof CODEX_JOB_ROLE_MODELS;

function now(): string { return new Date().toISOString(); }

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function collectText(value: unknown, output: string[]): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") output.push(record.text);
  for (const child of Object.values(record)) {
    if (child && typeof child === "object") collectText(child, output);
  }
}

/**
 * Codex argv for one dispatch. Exported as the testable seam for tier flags.
 * t0 pins a cheap model, t1 (and no tier) keeps the configured/default model,
 * t1 keeps the Sol coordinator at low reasoning for token-efficient everyday
 * orchestration; t2 raises reasoning effort for genuinely complex work.
 *
 * The sandbox follows `readOnly` and nothing else: Henry is agentic by design —
 * its brain (repl, telegram, dashboard chat, jobs, standup, the scheduler)
 * legitimately runs CLI commands and edits files on Luvish's machine, and that
 * IS the product.
 */
export function codexArgs(
  prompt: string,
  options: { readOnly?: boolean; tier?: DispatchTier; model?: string; t0Model?: string; session?: { id: string; fresh: boolean } } = { readOnly: false },
): string[] {
  // `model` is the normal/t1/t2 model. Keep the t0 worker separate so a
  // caller's heavyweight configured model can never accidentally reach a
  // cheap dispatch, while deployments may still choose their own t0 worker.
  const model = options.tier === "t0" ? (options.t0Model || CODEX_T0_MODEL) : options.model;
  const isResume = options.session !== undefined && !options.session.fresh;
  const effort = options.tier === "t2" ? "high" : "low";
  const config = [
    "-c", 'approval_policy="never"',
    // `codex exec resume` does not accept `--sandbox`; its equivalent must be a
    // config override. Keeping this explicit also prevents the global xhigh
    // operator preference from leaking into Henry's interactive latency path.
    ...(isResume ? ["-c", `sandbox_mode="${options.readOnly ? "read-only" : "danger-full-access"}"`] : []),
    "-c", `model_reasoning_effort="${effort}"`,
  ];
  // Sessions imply persistence: drop --ephemeral whenever a surface session is in play.
  // Important CLI detail: `resume` options precede SESSION_ID; arguments after it
  // are interpreted as the prompt. The older order made every resumed Codex turn
  // fail on `--sandbox` before the model could respond.
  if (isResume) {
    return [
      "exec", "resume",
      ...(model ? ["-m", model] : []),
      "--json", ...config, "--skip-git-repo-check",
      options.session!.id, prompt,
    ];
  }
  return [
    "exec",
    ...(model ? ["-m", model] : []),
    "--json", ...(options.session ? [] : ["--ephemeral"]),
    "--sandbox", options.readOnly ? "read-only" : "danger-full-access",
    ...config,
    "--skip-git-repo-check", prompt,
  ];
}

/** Claude tier defaults, used when a deployment names no model of its own. */
export const CLAUDE_T0_MODEL = "haiku";
export const CLAUDE_T2_MODEL = "opus";

/**
 * Claude argv for one dispatch (subscription CLI — never the API).
 * t0 → the t0 worker, t2 → the deep specialist, t1/absent → the configured model
 * or the CLI's own default.
 *
 * The tier models are parameters rather than literals for the same reason the Codex
 * side takes them: which model serves a tier is a DEPLOYMENT decision, so moving the
 * brain back to the Claude seat stays a config change and never a code change. The
 * defaults reproduce the previous hardcoded haiku/opus behaviour exactly.
 *
 * The shape is the prompt followed by `--dangerously-skip-permissions`, which is
 * how the agent edits files on Luvish's machine.
 */
export function claudeArgs(
  prompt: string,
  options: { readOnly?: boolean; tier?: DispatchTier; model?: string; t0Model?: string; t2Model?: string; session?: { id: string; fresh: boolean } } = {},
): string[] {
  const model = options.tier === "t0"
    ? (options.t0Model || CLAUDE_T0_MODEL)
    : options.tier === "t2"
      ? (options.t2Model || CLAUDE_T2_MODEL)
      : options.model;
  const session = options.session ? sessionArgs("claude", options.session).claudeArgs : [];
  return ["-p", ...(model ? ["--model", model] : []), ...session, prompt, "--dangerously-skip-permissions"];
}

export function buildProviderArgs(
  provider: ProviderName,
  prompt: string,
  options: {
    readOnly: boolean; tier?: DispatchTier; role?: string;
    codexModel?: string; codexT0Model?: string; codexT2Model?: string;
    codexResumeTailorModel?: string; codexApplicationReviewModel?: string; codexApplicationManagerModel?: string;
    claudeModel?: string; claudeT0Model?: string; claudeT2Model?: string; session?: { id: string; fresh: boolean };
  },
): string[] {
  const route = resolveProviderRoute(provider, options);
  return provider === "codex"
    ? codexArgs(prompt, { readOnly: options.readOnly, tier: route.tier, model: route.model, t0Model: options.codexT0Model, session: options.session })
    : claudeArgs(prompt, {
      readOnly: options.readOnly, tier: route.tier, model: route.model,
      t0Model: options.claudeT0Model, t2Model: options.claudeT2Model, session: options.session,
    });
}

export interface ProviderRoute {
  tier?: DispatchTier;
  model?: string;
  roleModelOverride: boolean;
}

export function resolveProviderRoute(
  provider: ProviderName,
  options: {
    tier?: DispatchTier; role?: string;
    codexModel?: string; codexT0Model?: string; codexT2Model?: string;
    codexResumeTailorModel?: string; codexApplicationReviewModel?: string; codexApplicationManagerModel?: string;
    claudeModel?: string; claudeT0Model?: string; claudeT2Model?: string;
  },
): ProviderRoute {
  if (provider === "codex" && isCodexJobRole(options.role)) {
    const routing = CODEX_JOB_ROLE_MODELS[options.role];
    return { tier: "t1", model: options[routing.key] || routing.fallback, roleModelOverride: true };
  }
  if (provider === "claude") {
    const model = options.tier === "t0"
      ? options.claudeT0Model || CLAUDE_T0_MODEL
      : options.tier === "t2"
        ? options.claudeT2Model || CLAUDE_T2_MODEL
        : options.claudeModel;
    return { tier: options.tier, model, roleModelOverride: false };
  }
  const model = options.tier === "t0"
    ? options.codexT0Model || CODEX_T0_MODEL
    : options.tier === "t2"
      ? options.codexT2Model || options.codexModel
      : options.codexModel;
  return { tier: options.tier, model, roleModelOverride: false };
}

function isCodexJobRole(role: string | undefined): role is CodexJobRole {
  return role === "resume-tailor" || role === "application-review" || role === "application-manager";
}

/**
 * Spawns a provider under a wall-clock envelope. On timeout the child gets
 * SIGTERM, then SIGKILL after a grace period, and the run resolves with
 * whatever partial output was captured (partial-results-on-failure, §7).
 * Exported for tests; production callers go through ProviderRunner.run.
 */
export async function execute(
  command: string,
  args: string[],
  cwd: string,
  provider: ProviderName,
  options: RunOptions = {},
): Promise<RunResult> {
  const runId = randomUUID();
  const started = Date.now();
  const events: ProviderEvent[] = [];
  const stdoutText: string[] = [];
  const stderrText: string[] = [];
  // Phase timings (latency §11.5 round 2): let slowness be diagnosed from the
  // activity log/dashboard without new UI. Both stay null if the run never
  // produced the corresponding event before completion/timeout.
  let firstEventMs: number | null = null;
  let firstTextMs: number | null = null;
  const child = spawn(command, args, {
    cwd,
    env: safeEnvironment(provider, { CI: "1", HENRY_RUN_ID: runId }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const emit = (stream: ProviderEvent["stream"], text: string): void => {
    const parsed = stream === "stdout" ? parseJsonLine(text) : undefined;
    const event: ProviderEvent = { timestamp: now(), stream, text, ...(parsed ? { parsed } : {}) };
    events.push(event);
    if (stream === "stdout") {
      if (firstEventMs === null) firstEventMs = Date.now() - started;
      if (firstTextMs === null && parsed) {
        const extracted: string[] = [];
        collectText(parsed, extracted);
        if (extracted.some((piece) => piece.trim())) firstTextMs = Date.now() - started;
      }
    }
    options.onEvent?.(event);
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  // Per-stream partial-line carry (audit 2026-08-09 H2): a JSONL event bigger than
  // one pipe chunk (~64KB, routine for long replies) used to be split mid-line,
  // fail parsing on both halves, and vanish from `response` entirely because other
  // small events still parsed. The remainder buffers stitch lines across chunks;
  // whatever is left unterminated at close is flushed as a final line.
  let stdoutRemainder = "";
  let stderrRemainder = "";
  child.stdout.on("data", (chunk: string) => {
    stdoutText.push(chunk);
    const lines = (stdoutRemainder + chunk).split(/\r?\n/);
    stdoutRemainder = lines.pop() ?? "";
    for (const line of lines) if (line) emit("stdout", line);
  });
  child.stderr.on("data", (chunk: string) => {
    stderrText.push(chunk);
    const lines = (stderrRemainder + chunk).split(/\r?\n/);
    stderrRemainder = lines.pop() ?? "";
    for (const line of lines) if (line) emit("stderr", line);
  });
  const flushRemainders = (): void => {
    if (stdoutRemainder.trim()) emit("stdout", stdoutRemainder);
    if (stderrRemainder.trim()) emit("stderr", stderrRemainder);
    stdoutRemainder = "";
    stderrRemainder = "";
  };

  const envelopeMs = options.timeoutMs ?? DEFAULT_ENVELOPE_MS;
  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  const envelopeTimer = envelopeMs > 0 && Number.isFinite(envelopeMs)
    ? setTimeout(() => {
        timedOut = true;
        emit("system", `${ENVELOPE_TIMEOUT_ERROR} after ${envelopeMs}ms; sending SIGTERM`);
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), ENVELOPE_KILL_GRACE_MS);
        killTimer.unref?.();
      }, envelopeMs)
    : undefined;
  envelopeTimer?.unref?.();

  const clearTimers = (): void => {
    if (envelopeTimer) clearTimeout(envelopeTimer);
    if (killTimer) clearTimeout(killTimer);
  };

  return await new Promise<RunResult>((resolve) => {
    child.once("error", (error) => {
      clearTimers();
      resolve({
        runId, provider, response: "", exitCode: null, durationMs: Date.now() - started,
        error: error.message, events, firstEventMs, firstTextMs,
      });
    });
    child.once("close", (exitCode) => {
      clearTimers();
      flushRemainders();
      const extracted: string[] = [];
      for (const event of events) if (event.parsed) collectText(event.parsed, extracted);
      const raw = stdoutText.join("").trim();
      const response = [...new Set(extracted.map((text) => text.trim()).filter(Boolean))].join("\n\n") || raw;
      if (timedOut) {
        resolve({
          runId, provider, response, exitCode: null, durationMs: Date.now() - started,
          error: ENVELOPE_TIMEOUT_ERROR, events, firstEventMs, firstTextMs,
        });
        return;
      }
      const error = exitCode === 0 ? undefined : stderrText.join("").trim() || `Provider exited with code ${exitCode}`;
      resolve({ runId, provider, response, exitCode, durationMs: Date.now() - started, ...(error ? { error } : {}), events, firstEventMs, firstTextMs });
    });
  });
}

/**
 * Signatures a provider CLI prints when its session has expired. These exit cleanly (code 0)
 * with a short "you're logged out" message instead of doing the actual work, so exitCode alone
 * can't catch it — observed live: codex's session expired mid-use and it printed "Not logged in
 * · Please run /login" with a clean exit, which ProviderRunner previously treated as SUCCESS.
 */
const AUTH_FAILURE_SIGNATURES = [
  "not logged in",
  "please run /login",
  "run codex login",
  "please login",
  "authentication required",
  "401 unauthorized",
  "token expired",
];

/**
 * True when `text` looks like an auth-failure message rather than real output. Matched
 * case-insensitively, and only trusted when either the WHOLE response is short (< 200 chars —
 * these messages are terse) or the response STARTS WITH the signature. That guard is what keeps
 * a long, normal reply that merely mentions e.g. "the login page" from tripping a false positive:
 * a 300-char answer discussing "login" somewhere in the middle never matches, but a bare
 * "Not logged in · Please run /login" (or any short reply carrying one of these phrases) does.
 * Exported for tests and reuse (e.g. surfacing a clear message to callers of read-only runs).
 */
export function isAuthFailureResponse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  const short = trimmed.length < 200;
  return AUTH_FAILURE_SIGNATURES.some((signature) => lower.includes(signature) && (short || lower.startsWith(signature)));
}

/** Repeated background jobs (mailwatch, etc.) hitting the same expired session shouldn't spam banners. */
const AUTH_NOTIFY_DEBOUNCE_MS = 10 * 60 * 1000;
const lastAuthNotifyAt = new Map<ProviderName, number>();

/**
 * Gates the "please re-login" notification to at most once per provider per 10 minutes.
 * Exported as the seam for tests (real notification delivery is not something a unit test
 * should trigger). Records `now` as the provider's last-notified time whenever it returns true.
 */
export function shouldNotifyAuthFailure(provider: ProviderName, now: number = Date.now()): boolean {
  const last = lastAuthNotifyAt.get(provider);
  if (last !== undefined && now - last < AUTH_NOTIFY_DEBOUNCE_MS) return false;
  lastAuthNotifyAt.set(provider, now);
  return true;
}

/**
 * Activity kinds for the failover story. Cast because `ActivityKind` lives in src/types.ts,
 * which this module does not own — ARCHITECT: add `| "provider.failover"` and
 * `| "provider.preflight-switch"` to that union and the casts can go away.
 */
export const FAILOVER_ACTIVITY_KIND = "provider.failover" as ActivityKind;
export const PREFLIGHT_ACTIVITY_KIND = "provider.preflight-switch" as ActivityKind;

/** Stamped on a RunResult that came from the OTHER CLI after the first one hit a wall. */
export interface FailoverAnnotation {
  from: ProviderName;
  to: ProviderName;
  reason: string;
  /** ISO instant the exhausted provider is expected back, when its CLI said so. */
  resetAt?: string;
}

/**
 * Which provider actually answered, and why it wasn't the first choice. `undefined` for a
 * normal single-provider run. Same out-of-band annotation idiom as `sessionReset`.
 */
export function failoverInfo(result: RunResult): FailoverAnnotation | undefined {
  return (result as { failover?: FailoverAnnotation }).failover;
}

export interface FallbackPolicy {
  /** `providers.fallback` — master switch, default ON. */
  fallback: boolean;
  /** `providers.fallbackPinned` — allow swapping a caller-pinned provider, default OFF. */
  fallbackPinned: boolean;
}

/**
 * Failover policy from `data/settings.json`:
 *
 *   { "providers": { "fallback": true, "fallbackPinned": false } }
 *
 * `fallback` defaults ON — running out of Claude tokens should quietly continue on Codex.
 * `fallbackPinned` defaults OFF on purpose: when a CALLER pinned the provider (the vision
 * classifier, the Codex-only mailwatch), that pin encodes a billing/policy decision, and
 * silently answering from the other subscription would move that spend onto the wrong
 * subscription. Operators who genuinely want pinned seats to roam must opt in.
 */
export function readFallbackPolicy(settingsPath: string): FallbackPolicy {
  const providers = readSettings(settingsPath).providers;
  const record = providers && typeof providers === "object" && !Array.isArray(providers)
    ? providers as Record<string, unknown>
    : {};
  return { fallback: record.fallback !== false, fallbackPinned: record.fallbackPinned === true };
}

/** Injected seams — production defaults spawn real CLIs, tests swap them for fakes. */
export interface ProviderRunnerDeps {
  /** Replaces the spawn-based `execute` (the only place a real subprocess is created). */
  execute?: typeof execute;
  /** Clock for cooldown math. */
  now?: () => Date;
  /** Operator notification for a logged-out CLI (defaults to the macOS banner). */
  notify?: ReminderNotifier;
  /** Pre-built cooldown ledger; defaults to `<dataDir>/provider-limits.json`. */
  limits?: ProviderLimitLedger;
}

export class ProviderRunner {
  private sessionManager?: SessionManager;
  private limitLedger?: ProviderLimitLedger;

  sessions(): SessionManager {
    this.sessionManager ||= new SessionManager(path.join(this.config.dataDir, "sessions.json"));
    return this.sessionManager;
  }

  /** The cooldown ledger backing failover. Public so a status surface can read it directly. */
  limits(): ProviderLimitLedger {
    this.limitLedger ||= new ProviderLimitLedger(this.limitsPath());
    return this.limitLedger;
  }

  private limitsPath(): string {
    return path.join(this.config.dataDir, LIMIT_LEDGER_FILE);
  }

  private settingsPath(): string {
    return this.config.settingsPath || path.join(this.config.dataDir, "settings.json");
  }

  /** Peek/create the session a surfaced run() will use — lets callers slim resumed prompts. */
  acquireSession(surface: string, provider?: ProviderName): { id: string; fresh: boolean; provider: ProviderName } {
    const p = provider || this.config.provider;
    return { ...this.sessions().acquire(surface, p), provider: p };
  }

  private readonly admission: AdmissionController;
  private readonly executeFn: typeof execute;
  private readonly nowFn: () => Date;
  private readonly notifyFn: ReminderNotifier;

  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    // Defaults to the process-wide controller so every runner (Luna, the agent,
    // the scheduler) shares one budget without changing its own constructor.
    admission: AdmissionController = sharedAdmissionController(),
    deps: ProviderRunnerDeps = {},
  ) {
    this.admission = admission;
    this.executeFn = deps.execute ?? execute;
    this.nowFn = deps.now ?? (() => new Date());
    this.notifyFn = deps.notify ?? notifyReminder;
    if (deps.limits) this.limitLedger = deps.limits;
    // Point the module-level status helpers (providerAvailable/limitState) at this runner's
    // ledger so `:status` can report provider health without reaching for a runner instance.
    configureProviderLimits(deps.limits?.path ?? this.limitsPath());
  }

  /**
   * Limit/availability verdict for a FAILED attempt. The envelope timeout is deliberately never
   * a limit (it is our own SIGTERM), and a spawn that never started is "unavailable", not quota.
   */
  private classifyFailure(result: RunResult, at: Date): LimitDetection {
    if (result.error === ENVELOPE_TIMEOUT_ERROR) return { limited: false };
    const neverStarted = result.exitCode === null && result.events.length === 0;
    if (neverStarted && detectMissingBinary(result.error)) {
      return { limited: true, kind: "unavailable", reason: `${result.provider} CLI could not be spawned (${result.error})` };
    }
    return detectRunLimit(result, at);
  }

  /** The message a caller gets instead of a doomed spawn: who is down, why, and until when. */
  private limitedMessage(
    state: LimitState,
    considered: ProviderName[],
    context: { pinned: boolean; policy: FallbackPolicy; lastError?: string },
  ): string {
    const head = describeLimited(state, considered);
    const pinnedNote = context.pinned && !context.policy.fallbackPinned
      ? ` This run pinned ${considered[0]}; set providers.fallbackPinned=true in data/settings.json to let pinned runs use the other CLI.`
      : "";
    const tail = context.lastError ? ` Last error: ${context.lastError.slice(0, 200)}` : "";
    return `${head}${pinnedNote}${tail}`;
  }

  private async recordFailover(
    from: ProviderName,
    to: ProviderName,
    reason: string,
    resetAt: string | undefined,
    options: RunOptions,
  ): Promise<void> {
    await this.activity.record(
      FAILOVER_ACTIVITY_KIND,
      `${from} → ${to}: ${reason}`,
      { from, to, reason, ...(resetAt ? { resetAt } : {}) },
      { provider: to, role: options.role },
    );
  }

  async run(prompt: string, options: RunOptions = {}): Promise<RunResult> {
    const at = this.nowFn();
    const ledger = this.limits();
    const policy = readFallbackPolicy(this.settingsPath());
    // A caller-set provider is a PIN (a billing/policy decision), not a preference — see
    // readFallbackPolicy. `config.provider` is only the default and may always roam.
    const isPinned = options.provider !== undefined;
    const preferred = options.provider || this.config.provider;
    const alternate: ProviderName = preferred === "codex" ? "claude" : "codex";
    // Claude's installed CLI does not expose a verified read-only mode in the
    // contract we use here. Never turn a read-only review into a write-capable
    // FALLBACK; an EXPLICIT caller choice of claude (e.g. vision classification)
    // is honored as a single-provider run with no fallback either way.
    const sequence: ProviderName[] = options.readOnly
      ? [options.provider === "claude" ? "claude" as const : "codex" as const]
      : isPinned
        ? (policy.fallback && policy.fallbackPinned ? [preferred, alternate] : [preferred])
        : (policy.fallback ? [preferred, alternate] : [preferred]);

    // PRE-FLIGHT (§5): a CLI already known to be out of quota is dropped — spending a spawn and
    // an envelope on a guaranteed refusal helps nobody. SOFT cooldowns (logged out, binary
    // missing) only demote: the operator may have re-logged in a second ago.
    // One ledger snapshot for the whole planning phase (the loop re-reads as it marks).
    const state = ledger.state(at);
    const eligible = sequence.filter((provider) => state[provider]?.kind !== "limit");
    const order: ProviderName[] = [
      ...eligible.filter((provider) => state[provider] === undefined),
      ...eligible.filter((provider) => state[provider] !== undefined),
    ];

    if (!order.length) {
      const message = this.limitedMessage(state, sequence, { pinned: isPinned, policy });
      const refused: RunResult = {
        runId: randomUUID(), provider: sequence[0], response: "", exitCode: null, durationMs: 0,
        error: message, events: [], limited: true,
      };
      await this.activity.record(
        "run.failed",
        "No provider available: every candidate is out of quota",
        { error: message, limited: true, considered: sequence, limits: state },
        { runId: refused.runId, provider: sequence[0], role: options.role },
      );
      return refused;
    }

    if (order[0] !== sequence[0]) {
      const skipped = sequence[0];
      const entry = state[skipped];
      await this.activity.record(
        PREFLIGHT_ACTIVITY_KIND,
        `Starting on ${order[0]}: ${skipped} is ${entry?.kind === "limit" ? "out of quota" : "unavailable"} until ${entry?.until}`,
        { from: skipped, to: order[0], reason: entry?.reason, kind: entry?.kind, until: entry?.until },
        { provider: order[0], role: options.role },
      );
    }

    const envelopeMs = options.timeoutMs ?? DEFAULT_ENVELOPE_MS;
    let last: RunResult | undefined;
    /** Set once the first CLI bails out, so the answer can be stamped with who actually ran. */
    let handoff: FailoverAnnotation | undefined;

    for (let index = 0; index < order.length; index++) {
      const provider = order[index];
      const next: ProviderName | undefined = order[index + 1];
      // Surface sessions: reuse the caller's precomputed session when it matches
      // this provider; a fallback provider gets its own surface session instead.
      const session = options.surface
        ? (options.session && options.session.provider === provider
            ? { id: options.session.id, fresh: options.session.fresh }
            : this.sessions().acquire(options.surface, provider))
        : undefined;
      const args = buildProviderArgs(provider, prompt, {
        readOnly: options.readOnly === true,
        tier: options.tier,
        role: options.role,
        codexModel: this.config.codexModel,
        codexT0Model: this.config.codexT0Model,
        codexT2Model: this.config.codexT2Model,
        codexResumeTailorModel: this.config.codexResumeTailorModel,
        codexApplicationReviewModel: this.config.codexApplicationReviewModel,
        codexApplicationManagerModel: this.config.codexApplicationManagerModel,
        claudeModel: this.config.claudeModel,
        claudeT0Model: this.config.claudeT0Model,
        claudeT2Model: this.config.claudeT2Model,
        session,
      });
      const route = resolveProviderRoute(provider, {
        tier: options.tier,
        role: options.role,
        codexModel: this.config.codexModel,
        codexT0Model: this.config.codexT0Model,
        codexT2Model: this.config.codexT2Model,
        codexResumeTailorModel: this.config.codexResumeTailorModel,
        codexApplicationReviewModel: this.config.codexApplicationReviewModel,
        codexApplicationManagerModel: this.config.codexApplicationManagerModel,
        claudeModel: this.config.claudeModel,
        claudeT0Model: this.config.claudeT0Model,
        claudeT2Model: this.config.claudeT2Model,
      });
      const cwd = options.cwd || this.config.rootDir;
      const decision = await this.admission.waitForSlot({ provider, timeoutMs: envelopeMs, label: options.role });
      const queued = decision.queuedMs >= QUEUE_NOTICE_MS;

      if (!decision.admitted) {
        const error = decision.reason === "pressure"
          ? "admission refused: memory pressure critical"
          : "admission refused: timed out waiting for a provider slot";
        await this.activity.record(
          "run.started",
          `Refused ${provider} spawn (${decision.reason})`,
          {
            cwd, tier: route.tier, requestedTier: options.tier ?? null, model: route.model ?? null,
            role: options.role ?? null, roleModelOverride: route.roleModelOverride,
            queuedMs: decision.queuedMs, queued: true, refused: decision.reason, pressure: decision.pressure,
          },
          { provider, role: options.role },
        );
        last = { runId: randomUUID(), provider, response: "", exitCode: null, durationMs: decision.queuedMs, error, events: [] };
        await this.activity.record("run.failed", `${provider} not admitted; considering fallback`, { error }, { runId: last.runId, provider, role: options.role });
        continue;
      }

      await this.activity.record(
        "run.started",
        `Starting ${provider} run`,
        {
          cwd, tier: route.tier, requestedTier: options.tier ?? null, model: route.model ?? null,
          role: options.role ?? null, roleModelOverride: route.roleModelOverride,
          promptBuildMs: options.promptBuildMs ?? null, queuedMs: decision.queuedMs, ...(queued ? { queued: true } : {}),
        },
        { provider, role: options.role },
      );
      let result: RunResult;
      try {
        result = await this.executeFn(provider, args, cwd, provider, { ...options, timeoutMs: envelopeMs });
      } finally {
        decision.slot.release();
      }
      if (result.exitCode === 0 && isAuthFailureResponse(result.response)) {
        // A clean exit with a "you're logged out" body is a FAILURE, not success — the caller
        // must not mistake it for real output, and the next provider in sequence (if any) gets
        // a turn exactly like a nonzero exit would trigger.
        const authError = `${provider} session logged out — run \`codex login\` / \`claude\` to re-auth`;
        result = { ...result, error: authError };
        last = result;
        // §6: logged out counts as UNAVAILABLE, not a crash loop. A SHORT cooldown stops every
        // background job from re-spawning the same dead session, while still letting a
        // last-resort attempt through the moment there is no alternative (the operator may have
        // re-logged in seconds ago).
        ledger.markLimited(provider, { limited: true, kind: "auth", reason: authError }, at);
        await this.activity.record(
          "run.failed",
          `${provider} session expired; considering fallback`,
          { error: authError, authFailure: true },
          { runId: result.runId, provider, role: options.role },
        );
        if (shouldNotifyAuthFailure(provider)) {
          const fallbackNote = next ? `Falling back to ${next}.` : "No fallback available.";
          void this.notifyFn(
            `⚠️ ${provider} session logged out — run \`codex login\` (or \`claude\`) to re-auth. ${fallbackNote}`,
            "Henry needs re-login",
          ).catch(() => undefined);
        }
        if (!next) break;
        await this.recordFailover(provider, next, authError, undefined, options);
        handoff = { from: provider, to: next, reason: authError };
        continue;
      }
      // CLEAN-EXIT LIMIT TRAP: both CLIs have been seen printing "usage limit reached · resets
      // 3pm" as the ANSWER and exiting 0. Only the (terse) body counts as evidence on a clean
      // exit — a stderr retry-warning on an otherwise successful run must never park a healthy
      // provider. A failed attempt gets the full evidence set (error + stderr + short stdout).
      const answered = result.exitCode === 0 && result.response.trim().length > 0;
      const detection = answered ? detectRunLimit({ response: result.response }, at) : this.classifyFailure(result, at);
      if (answered && detection.limited) result = { ...result, error: detection.reason ?? "provider limit reached" };
      last = result;
      if (answered && !detection.limited) {
        // Fallback-freshness signal (audit 2026-08-09 L2): the caller built a slim
        // "session resumed" prompt for the PRIMARY provider's resumed session, but
        // this (fallback) provider started a FRESH session that has none of the
        // static blocks. Reuse the sessionReset retry channel so the caller
        // rebuilds the full prompt once.
        if (session?.fresh && options.session && !options.session.fresh) {
          (result as { sessionReset?: boolean }).sessionReset = true;
        }
        // This CLI just produced real work: whatever cooldown it carried is stale.
        ledger.clear(provider, at);
        // Annotate WHO answered when it wasn't the first choice, so callers (and the REPL
        // banner) can say "Claude was out of tokens — Codex answered".
        if (handoff) (result as { failover?: FailoverAnnotation }).failover = { ...handoff, to: provider };
        if (options.surface && session) {
          if (provider === "codex" && session.fresh) {
            // Codex mints its own id (thread.started event) — store the REAL one for resume.
            const threadEvent = result.events.find((e) => e.parsed && (e.parsed as Record<string, unknown>).type === "thread.started");
            const threadId = threadEvent && String((threadEvent.parsed as Record<string, unknown>).thread_id || "");
            if (threadId) this.sessions().updateId(options.surface, provider, threadId);
          }
          this.sessions().markUsed(options.surface, provider);
        }
        await this.activity.record("run.completed", `${provider} completed`, {
          durationMs: result.durationMs,
          firstEventMs: result.firstEventMs ?? null,
          firstTextMs: result.firstTextMs ?? null,
          tier: options.tier,
          promptBuildMs: options.promptBuildMs ?? null,
          promptChars: prompt.length,
          ...(handoff ? { failoverFrom: handoff.from } : {}),
        }, { runId: result.runId, provider, role: options.role });
        return result;
      }
      if (options.surface && session && !session.fresh) {
        // A failed resumed turn may mean the provider evicted the session — reset
        // so the caller's retry (or next turn) starts fresh instead of looping.
        // The failover retry below therefore always runs on a FRESH session with the full
        // prompt: a resumed session id cannot cross providers.
        this.sessions().reset(options.surface, provider);
        (result as { sessionReset?: boolean }).sessionReset = true;
      }
      if (detection.limited) {
        // §2 + §3: park this CLI until its reset, then hand the SAME prompt to the other one
        // (once — `order` holds at most two entries).
        const entry = ledger.markLimited(provider, detection, at);
        await this.activity.record(
          "run.failed",
          `${provider} ${entry.kind === "limit" ? "is out of quota" : "is unavailable"} until ${entry.until}`,
          {
            error: result.error, limited: true, kind: entry.kind, matched: detection.matched,
            reason: entry.reason, until: entry.until, parsedReset: entry.parsedReset === true,
          },
          { runId: result.runId, provider, role: options.role },
        );
        if (next) {
          await this.recordFailover(provider, next, entry.reason, entry.until, options);
          handoff = { from: provider, to: next, reason: entry.reason, resetAt: entry.until };
          continue;
        }
        // Nothing left to try: say who is down and when the earliest one returns.
        // `limited` marks this as "out of quota", not "the work broke", so a caller can
        // keep the task and resume it instead of discarding it as a failed answer.
        last = {
          ...result,
          error: this.limitedMessage(ledger.state(at), sequence, { pinned: isPinned, policy, lastError: result.error }),
          limited: true,
        };
        break;
      }
      await this.activity.record("run.failed", `${provider} failed; considering fallback`, { error: result.error }, { runId: result.runId, provider, role: options.role });
    }
    return last || {
      runId: randomUUID(), provider: preferred, response: "", exitCode: null, durationMs: 0,
      error: "No provider was available", events: [],
    };
  }
}
