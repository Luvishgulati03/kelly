import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ClaudeEffort, HenryConfig } from "../config.ts";
import { getActiveProfile } from "../profile.ts";
import type { ActivityLog } from "../activity.ts";
import type { ActivityKind, DispatchTier, ProviderEvent, ProviderName, RunResult } from "../types.ts";
import { safeEnvironment } from "../util/env.ts";
import { isPublicTurn } from "../guardrails.ts";
import { publicClaudeArgs, publicCodexArgs, publicEnvironment, publicTurnViolation } from "./public-sandbox.ts";
import path from "node:path";
import { SessionManager, sessionArgs } from "./session.ts";
import { createProviderTextStream, providerStreamText } from "./stream-text.ts";
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
  /**
   * How firmly `provider` binds. Absent: a billing pin that roams only with
   * providers.fallbackPinned. "soft": a preference that hands off to the other CLI whenever
   * failover is allowed. "hard": never roams (approved outbound sends, probes).
   */
  pin?: "hard" | "soft";
  cwd?: string;
  role?: string;
  /**
   * Codex: the read-only sandbox. Claude: `--permission-mode dontAsk` with a read-only tool
   * allowlist (Read/Grep/Glob/WebSearch/WebFetch, plus the read-only kelly_excel tools on the
   * Kelly profile) and the write tools denied by name.
   */
  readOnly?: boolean;
  /** MASTER_PLAN §11.1 tier; absent keeps the configured default models. */
  tier?: DispatchTier;
  /** Time spent assembling prompt/memory/RAG before this provider is admitted. */
  promptBuildMs?: number;
  /** Wall-clock envelope per provider attempt (§7). */
  timeoutMs?: number;
  /** Structured-output schema file: Codex `--output-schema`, Claude `--json-schema` (compacted). */
  outputSchemaPath?: string;
  /**
   * Claude only: stream token-level text deltas (`--include-partial-messages`). Defaults to on
   * whenever `onEvent` is set, so an interactive surface can render text as it arrives. Read it
   * with createProviderTextStream() (src/providers/stream-text.ts), never `parsed.text`.
   */
  partialMessages?: boolean;
  /** Raw human request used by Kelly's catalogue retriever when the provider prompt has wrappers. */
  catalogueQuery?: string;
  /**
   * A PUBLIC VISITOR TURN (src/public/turn.ts). The run is spawned with the public sandbox argv
   * (src/providers/public-sandbox.ts: no tools, no MCP, no settings, no session), a minimal
   * environment carrying KELLY_PUBLIC_TURN=1, in `cwd` (required: an empty scratch directory),
   * and any answer whose events show a tool call is discarded. `surface`, `session`,
   * `outputSchemaPath` and `catalogueQuery` are ignored; there is no failover. `systemPrompt`
   * carries the public rules: Codex receives it prepended to the prompt; Claude via
   * --system-prompt.
   */
  publicTurn?: {
    systemPrompt: string;
    /** A model per provider for this public turn (KELLY_PUBLIC_MODEL); absent keeps the tier's model. */
    models?: Partial<Record<ProviderName, string>>;
  };
  onEvent?: (event: ProviderEvent) => void;
}

export const PUBLIC_TURN_NESTED_REFUSAL = "A public visitor turn cannot start another provider run.";

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

/** Token accounting for one run, as the CLI itself reported it. Absent when the CLI printed none. */
export interface RunUsage { input: number; cached: number; output: number }

/**
 * Codex closes a turn with `{"type":"turn.completed","usage":{input_tokens,cached_input_tokens,
 * output_tokens}}`; Claude's stream-json `result` event carries `usage` with `input_tokens`,
 * `cache_creation_input_tokens`, `cache_read_input_tokens` and `output_tokens`. Neither CLI bills in money on a
 * subscription, so tokens are the honest unit the dashboard can show.
 */
export function providerUsage(events: ProviderEvent[], provider: ProviderName): RunUsage | undefined {
  const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const parsed = events[index]?.parsed;
    if (!parsed) continue;
    const usage = parsed.usage as Record<string, unknown> | undefined;
    if (!usage || typeof usage !== "object") continue;
    if (provider === "codex" && parsed.type === "turn.completed") {
      return { input: num(usage.input_tokens), cached: num(usage.cached_input_tokens), output: num(usage.output_tokens) };
    }
    if (provider === "claude" && parsed.type === "result") {
      // Claude splits the prompt into uncached, cache-written and cache-read tokens. `input` is
      // their sum, so it means the same as Codex's input_tokens (which already includes cached).
      const cached = num(usage.cache_read_input_tokens);
      return { input: num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + cached, cached, output: num(usage.output_tokens) };
    }
  }
  return undefined;
}

/** Codex JSONL can contain several commentary messages before its final schema-bound answer. */
export function finalCodexAgentMessage(events: ProviderEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const parsed = events[index]?.parsed as Record<string, unknown> | undefined;
    if (parsed?.type !== "item.completed") continue;
    const item = parsed.item as Record<string, unknown> | undefined;
    if (item?.type === "agent_message" && typeof item.text === "string" && item.text.trim()) return item.text.trim();
  }
  return undefined;
}

/**
 * Codex argv for one dispatch. Exported as the testable seam for tier flags.
 * t0 pins a cheap model, t1 (and no tier) keeps the configured/default model,
 * t1 keeps the Sol coordinator at low reasoning for token-efficient everyday
 * orchestration; t2 raises reasoning effort for genuinely complex work.
 *
 * The sandbox follows `readOnly` and nothing else: Henry is agentic by design —
 * its brain (repl, telegram, dashboard chat, jobs, standup, the scheduler)
 * legitimately runs CLI commands and edits files on the owner's machine, and that
 * IS the product.
 */
export function codexArgs(
  prompt: string,
  options: { readOnly?: boolean; tier?: DispatchTier; model?: string; t0Model?: string; session?: { id: string; fresh: boolean }; outputSchemaPath?: string } = { readOnly: false },
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
    ...(options.outputSchemaPath ? ["--output-schema", options.outputSchemaPath] : []),
    "--sandbox", options.readOnly ? "read-only" : "danger-full-access",
    ...config,
    "--skip-git-repo-check", prompt,
  ];
}

/** Claude tier defaults, used when a deployment names no model of its own. */
export const CLAUDE_T0_MODEL = "haiku";
export const CLAUDE_T2_MODEL = "opus";

/** Built-in tools a read-only Claude run may use: look, search, fetch — never mutate. */
export const CLAUDE_READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "WebSearch", "WebFetch"];
/** Denied outright on read-only runs, on top of dontAsk's allowlist. */
export const CLAUDE_WRITE_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit"];

/** The MCP server name Kelly's Claude runs register (same name as `.codex/config.toml`). */
export const KELLY_EXCEL_MCP_SERVER = "kelly_excel";
/** kelly_excel tools that only read a workbook — allowed on read-only Kelly runs. */
export const KELLY_EXCEL_READ_TOOLS = [
  "mcp__kelly_excel__excel_inspect_workbook",
  "mcp__kelly_excel__excel_read_range",
  "mcp__kelly_excel__excel_search_workbook",
];
/** The generated Claude `--mcp-config` file, inside the data directory (git-ignored, 0600). */
export const CLAUDE_MCP_CONFIG_FILE = "claude-mcp.json";
/** Absolute path to this checkout's Excel MCP entry point, wherever the process was started. */
export const KELLY_EXCEL_MCP_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "kelly-excel-mcp.mjs");

/**
 * This process's node binary by a path that survives upgrades: a PATH entry (e.g.
 * /opt/homebrew/bin/node) that resolves to the same binary wins over the versioned
 * `.../Cellar/node/<version>/bin/node` that process.execPath reports.
 */
export function stableNodePath(execPath: string = process.execPath, searchPath: string = process.env.PATH ?? ""): string {
  let target: string;
  try { target = realpathSync(execPath); } catch { return execPath; }
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, "node");
    try { if (realpathSync(candidate) === target) return candidate; } catch { /* not here */ }
  }
  return execPath;
}

/**
 * The Claude `--mcp-config` document for Kelly's brain runs: exactly the kelly_excel server, by
 * absolute paths (node binary and entry point), so it starts no matter which cwd a run uses.
 * Paired with `--strict-mcp-config`, a Kelly run sees this server and none of the owner's
 * personal claude.ai connectors or user-level MCP servers.
 */
export function kellyClaudeMcpConfig(nodePath: string = stableNodePath(), entry: string = KELLY_EXCEL_MCP_ENTRY): string {
  return `${JSON.stringify({ mcpServers: { [KELLY_EXCEL_MCP_SERVER]: { type: "stdio", command: nodePath, args: [entry] } } }, null, 2)}\n`;
}

/**
 * Writes (or refreshes) `<dataDir>/claude-mcp.json` with owner-only permissions and returns its
 * path. Rewritten only when the content changed; the mode is enforced every time.
 */
export function writeClaudeMcpConfig(dataDir: string, content: string = kellyClaudeMcpConfig()): string {
  const file = path.join(dataDir, CLAUDE_MCP_CONFIG_FILE);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let current: string | undefined;
  try { current = readFileSync(file, "utf8"); } catch { /* first write */ }
  if (current !== content) writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/**
 * Claude argv for one dispatch (subscription CLI — never the API).
 * t0 → the t0 worker, t2 → the deep specialist, t1/absent → the configured model
 * or the CLI's own default. Effort follows the same tiering (`--effort`, only when configured).
 *
 * The tier models are parameters rather than literals for the same reason the Codex
 * side takes them: which model serves a tier is a DEPLOYMENT decision, so moving the
 * brain between seats stays a config change and never a code change.
 *
 * A writable run is the prompt followed by `--dangerously-skip-permissions`, which is how the
 * agent edits files on the owner's machine. A read-only run is Claude's equivalent of Codex's
 * read-only sandbox: `dontAsk` denies every tool not on the read allowlist, and the write tools
 * are denied by name as well.
 *
 * ARGUMENT ORDER MATTERS: --allowedTools, --disallowedTools and --mcp-config are variadic, so
 * they sit AFTER the prompt (each list is one comma-joined argument) and are always followed by
 * another flag; placed before the prompt they would swallow it as a tool name or config file.
 */
export function claudeArgs(
  prompt: string,
  options: {
    readOnly?: boolean; tier?: DispatchTier; model?: string; t0Model?: string; t2Model?: string;
    /** t1/no-tier effort; t0Effort/t2Effort for their tiers. Unset → no --effort flag. */
    effort?: ClaudeEffort; t0Effort?: ClaudeEffort; t2Effort?: ClaudeEffort;
    session?: { id: string; fresh: boolean };
    /** Compact JSON Schema text — the Claude counterpart of Codex's --output-schema. */
    jsonSchema?: string;
    /** Stream JSON events (`--verbose --output-format stream-json`): result, usage, init. */
    streamJson?: boolean;
    /** Token-level deltas (`--include-partial-messages`); implies streamJson. */
    partialMessages?: boolean;
    allowedTools?: string[];
    disallowedTools?: string[];
    /** `--mcp-config <file>`; with strictMcp, the ONLY MCP servers the run may load. */
    mcpConfigPath?: string;
    strictMcp?: boolean;
    /** `--setting-sources` (e.g. "project": repo settings + CLAUDE.md, no user hooks/settings). */
    settingSources?: string;
  } = {},
): string[] {
  const model = options.tier === "t0"
    ? (options.t0Model || CLAUDE_T0_MODEL)
    : options.tier === "t2"
      ? (options.t2Model || CLAUDE_T2_MODEL)
      : options.model;
  const effort = options.tier === "t0" ? options.t0Effort : options.tier === "t2" ? options.t2Effort : options.effort;
  const session = options.session ? sessionArgs("claude", options.session).claudeArgs : [];
  const head = [
    "-p",
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--effort", effort] : []),
    ...(options.settingSources !== undefined ? ["--setting-sources", options.settingSources] : []),
    ...session,
    prompt,
  ];
  const streamed = options.jsonSchema || options.streamJson || options.partialMessages
    ? [
      "--verbose", "--output-format", "stream-json",
      ...(options.partialMessages ? ["--include-partial-messages"] : []),
      ...(options.jsonSchema ? ["--json-schema", options.jsonSchema] : []),
    ]
    : [];
  const mcp = options.mcpConfigPath
    ? ["--mcp-config", options.mcpConfigPath, ...(options.strictMcp ? ["--strict-mcp-config"] : [])]
    : options.strictMcp ? ["--strict-mcp-config"] : [];
  const denied = options.disallowedTools ?? [];
  if (options.readOnly) {
    return [
      ...head, ...streamed, ...mcp,
      "--permission-mode", "dontAsk",
      "--allowedTools", [...CLAUDE_READ_ONLY_TOOLS, ...(options.allowedTools ?? [])].join(","),
      "--disallowedTools", [...CLAUDE_WRITE_TOOLS, ...denied].join(","),
    ];
  }
  return [...head, ...streamed, ...mcp, "--dangerously-skip-permissions", ...(denied.length ? ["--disallowedTools", denied.join(",")] : [])];
}

export function buildProviderArgs(
  provider: ProviderName,
  prompt: string,
  options: {
    readOnly: boolean; tier?: DispatchTier; role?: string;
    codexModel?: string; codexT0Model?: string; codexT2Model?: string;
    codexResumeTailorModel?: string; codexApplicationReviewModel?: string; codexApplicationManagerModel?: string;
    claudeModel?: string; claudeT0Model?: string; claudeT2Model?: string; session?: { id: string; fresh: boolean };
    claudeEffort?: ClaudeEffort; claudeT0Effort?: ClaudeEffort; claudeT2Effort?: ClaudeEffort;
    outputSchemaPath?: string;
    claudeJsonSchema?: string; claudeStreamJson?: boolean; claudePartialMessages?: boolean;
    claudeAllowedTools?: string[]; claudeDisallowedTools?: string[];
    claudeMcpConfigPath?: string; claudeStrictMcp?: boolean; claudeSettingSources?: string;
  },
): string[] {
  const route = resolveProviderRoute(provider, options);
  return provider === "codex"
    ? codexArgs(prompt, { readOnly: options.readOnly, tier: route.tier, model: route.model, t0Model: options.codexT0Model, session: options.session, outputSchemaPath: options.outputSchemaPath })
    : claudeArgs(prompt, {
      readOnly: options.readOnly, tier: route.tier, model: route.model,
      t0Model: options.claudeT0Model, t2Model: options.claudeT2Model,
      effort: options.claudeEffort, t0Effort: options.claudeT0Effort, t2Effort: options.claudeT2Effort,
      session: options.session,
      jsonSchema: options.claudeJsonSchema, streamJson: options.claudeStreamJson, partialMessages: options.claudePartialMessages,
      allowedTools: options.claudeAllowedTools, disallowedTools: options.claudeDisallowedTools,
      mcpConfigPath: options.claudeMcpConfigPath, strictMcp: options.claudeStrictMcp, settingSources: options.claudeSettingSources,
    });
}

/**
 * A checked-in schema file as one compact argv string for Claude's --json-schema. The top-level
 * `$schema` dialect marker is dropped: Claude's validator rejects the draft 2020-12 URI Codex's
 * schemas carry, and the marker adds no constraint.
 */
export function compactSchema(schemaPath: string): string {
  const { $schema: _dialect, ...schema } = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
  return JSON.stringify(schema);
}

/**
 * Claude's stream-json run ends in one `result` event carrying the structured output (schema
 * runs) or the final text, plus whether the CLI itself reported an error (a usage-limit or
 * logged-out notice arrives this way, with `is_error: true`).
 */
export function finalClaudeResult(events: ProviderEvent[]): { response: string; isError: boolean } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const parsed = events[index]?.parsed;
    if (parsed?.type !== "result") continue;
    const structured = parsed.structured_output;
    const response = structured !== undefined && structured !== null
      ? JSON.stringify(structured)
      : typeof parsed.result === "string" ? parsed.result.trim() : "";
    return { response, isError: parsed.is_error === true };
  }
  return undefined;
}

/**
 * True when Claude's own stream marked the failure as authentication: a logged-out CLI emits a
 * synthetic assistant message with `"error":"authentication_failed"` (observed on 2.1.258 with
 * an empty config dir: "Not logged in · Please run /login", is_error, exit 1).
 */
export function claudeAuthFailed(events: ProviderEvent[]): boolean {
  return events.some((event) => event.parsed?.type === "assistant" && event.parsed.error === "authentication_failed");
}

/** What a Claude run's `system/init` event says it loaded: model, MCP servers, MCP tools. */
export interface ClaudeInitReport {
  model?: string;
  mcpServers: Array<{ name: string; status: string }>;
  mcpTools: string[];
  toolCount: number;
}

export function claudeInitReport(events: ProviderEvent[]): ClaudeInitReport | undefined {
  const init = events.find((event) => event.parsed?.type === "system" && event.parsed.subtype === "init")?.parsed;
  if (!init) return undefined;
  const tools = Array.isArray(init.tools) ? init.tools.filter((tool): tool is string => typeof tool === "string") : [];
  const servers = Array.isArray(init.mcp_servers) ? init.mcp_servers : [];
  return {
    ...(typeof init.model === "string" ? { model: init.model } : {}),
    mcpServers: servers
      .filter((server): server is Record<string, unknown> => Boolean(server) && typeof server === "object")
      .map((server) => ({ name: String(server.name ?? ""), status: String(server.status ?? "") })),
    mcpTools: tools.filter((tool) => tool.startsWith("mcp__")),
    toolCount: tools.length,
  };
}

export interface ProviderRoute {
  tier?: DispatchTier;
  model?: string;
  /** Claude `--effort` for this tier, when configured. */
  effort?: ClaudeEffort;
  roleModelOverride: boolean;
}

export function resolveProviderRoute(
  provider: ProviderName,
  options: {
    tier?: DispatchTier; role?: string;
    codexModel?: string; codexT0Model?: string; codexT2Model?: string;
    codexResumeTailorModel?: string; codexApplicationReviewModel?: string; codexApplicationManagerModel?: string;
    claudeModel?: string; claudeT0Model?: string; claudeT2Model?: string;
    claudeEffort?: ClaudeEffort; claudeT0Effort?: ClaudeEffort; claudeT2Effort?: ClaudeEffort;
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
    const effort = options.tier === "t0" ? options.claudeT0Effort : options.tier === "t2" ? options.claudeT2Effort : options.claudeEffort;
    return { tier: options.tier, model, ...(effort ? { effort } : {}), roleModelOverride: false };
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
  // Claude stream-json nests text (deltas, assistant content) and also carries text inside
  // tool results; the visible-text reader is what "first text" means for it.
  const claudeText = provider === "claude" ? createProviderTextStream() : undefined;
  const child = spawn(command, args, {
    cwd,
    // A public turn gets the minimal public environment (no tokens, no KELLY_* keys,
    // KELLY_PUBLIC_TURN=1); every other run keeps the usual allowlist.
    env: options.publicTurn ? publicEnvironment(provider, { HENRY_RUN_ID: runId }) : safeEnvironment(provider, { CI: "1", HENRY_RUN_ID: runId }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const emit = (stream: ProviderEvent["stream"], text: string): void => {
    const parsed = stream === "stdout" ? parseJsonLine(text) : undefined;
    const event: ProviderEvent = { timestamp: now(), stream, text, ...(parsed ? { parsed } : {}) };
    events.push(event);
    if (stream === "stdout") {
      if (firstEventMs === null) firstEventMs = Date.now() - started;
      if (firstTextMs === null && parsed) {
        if (claudeText) {
          if (claudeText(event)?.trim()) firstTextMs = Date.now() - started;
        } else {
          const extracted: string[] = [];
          collectText(parsed, extracted);
          if (extracted.some((piece) => piece.trim())) firstTextMs = Date.now() - started;
        }
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
      const combined = [...new Set(extracted.map((text) => text.trim()).filter(Boolean))].join("\n\n");
      // Claude: the final `result` event is the answer; a run cut short (no result) falls back
      // to the visible text it streamed, never to tool results or garbled delta joins.
      const claudeResult = provider === "claude" ? finalClaudeResult(events) : undefined;
      const claudeStreamed = provider === "claude" && !claudeResult?.response ? providerStreamText(events) : "";
      const response = (provider === "codex" && options.outputSchemaPath ? finalCodexAgentMessage(events) : undefined)
        ?? (claudeResult?.response || undefined)
        ?? (claudeStreamed || undefined)
        ?? (combined || raw);
      if (timedOut) {
        resolve({
          runId, provider, response, exitCode: null, durationMs: Date.now() - started,
          error: ENVELOPE_TIMEOUT_ERROR, events, firstEventMs, firstTextMs,
        });
        return;
      }
      const error = exitCode === 0 && !claudeResult?.isError
        ? undefined
        : stderrText.join("").trim() || (claudeResult?.isError ? claudeResult.response || "Claude reported an error" : `Provider exited with code ${exitCode}`);
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
  // Claude Code: an expired subscription token, a bad key, a failed auth handshake.
  "oauth token has expired",
  "invalid api key",
  "failed to authenticate",
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

const lastLimitNotifyAt = new Map<ProviderName, number>();

/** Same debounce for "out of quota — the other CLI took over", tracked separately from logouts. */
export function shouldNotifyLimit(provider: ProviderName, now: number = Date.now()): boolean {
  const last = lastLimitNotifyAt.get(provider);
  if (last !== undefined && now - last < AUTH_NOTIFY_DEBOUNCE_MS) return false;
  lastLimitNotifyAt.set(provider, now);
  return true;
}

/** The re-login command for a provider's CLI. */
export function reloginCommand(provider: ProviderName): string {
  return provider === "claude" ? "claude auth login" : "codex login";
}

/**
 * A finished run that failed because its CLI is logged out: a clean exit whose (short) answer
 * is a logged-out notice, a nonzero exit whose error says so, or Claude's own
 * `authentication_failed` marker. Pure; exported for tests.
 */
export function isAuthFailureRun(result: Pick<RunResult, "provider" | "exitCode" | "response" | "error" | "events">): boolean {
  if (result.error === ENVELOPE_TIMEOUT_ERROR) return false;
  if (result.provider === "claude" && claudeAuthFailed(result.events)) return true;
  if (result.exitCode === 0) return isAuthFailureResponse(result.response);
  if (result.exitCode === null) return false;
  // A FAILED run may also be recognised by a bare "/login" hint; a clean answer never is,
  // because a short, healthy reply can legitimately mention a /login page.
  const failedLogin = (text: string): boolean => isAuthFailureResponse(text) || (text.trim().length < 200 && /(?:^|\s)\/login\b/i.test(text));
  return failedLogin(result.response) || failedLogin(result.error ?? "");
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

/** What `kelly provider check` prints. */
export interface ClaudeCheckReport {
  ok: boolean;
  provider: "claude";
  model?: string;
  /** The generated --mcp-config file (Kelly profile). */
  mcpConfig?: string;
  mcpServers: Array<{ name: string; status: string }>;
  kellyExcelTools: string[];
  /** Any other MCP tool the run loaded; empty on Kelly, where --strict-mcp-config applies. */
  otherMcpTools: string[];
  response: string;
  error?: string;
  durationMs: number;
  firstTextMs: number | null;
  usage?: RunUsage;
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

  private mcpConfigPath?: string;

  /**
   * Kelly's generated Claude `--mcp-config` (kelly_excel only), written on first use. Public so
   * `kelly provider check` and status surfaces can name the file the brain runs actually load.
   */
  claudeMcpConfig(): string {
    this.mcpConfigPath ||= writeClaudeMcpConfig(this.config.dataDir);
    return this.mcpConfigPath;
  }

  /**
   * The Claude flags that make a Kelly brain run lean and self-contained (measured live on
   * 2.1.258: strict MCP cut first-text from ~5.7s to ~3.1s): exactly the kelly_excel MCP server (`--strict-mcp-config`, so none
   * of the owner's personal connectors load) and `--setting-sources project` (the repo's own
   * settings and CLAUDE.md, without user-level hooks or settings). The Henry profile keeps the
   * owner's full Claude setup.
   */
  private claudeRunExtras(readOnly: boolean): {
    claudeMcpConfigPath?: string; claudeStrictMcp?: boolean; claudeSettingSources?: string; readTools?: string[];
  } {
    if (this.config.profileId !== "kelly") return {};
    return {
      claudeMcpConfigPath: this.claudeMcpConfig(),
      claudeStrictMcp: true,
      claudeSettingSources: "project",
      ...(readOnly ? { readTools: KELLY_EXCEL_READ_TOOLS } : {}),
    };
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
    admission: AdmissionController = sharedAdmissionController(config.maxConcurrentRuns),
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

  /**
   * `kelly provider check`: one cheap headless Claude run (t0 model, read-only, hard-pinned, no
   * session) with the same MCP/settings flags a brain run gets, reporting what the CLI's init
   * event says it loaded. `ok` needs a clean answer and, on the Kelly profile, a connected
   * kelly_excel server that exposes at least one tool.
   */
  async checkClaude(timeoutMs = 90_000): Promise<ClaudeCheckReport> {
    const result = await this.run("Reply with exactly the word: ok", {
      provider: "claude", pin: "hard", tier: "t0", readOnly: true, role: "provider-check", timeoutMs,
    });
    const init = claudeInitReport(result.events);
    const kelly = this.config.profileId === "kelly";
    const kellyExcelTools = (init?.mcpTools ?? []).filter((tool) => tool.startsWith(`mcp__${KELLY_EXCEL_MCP_SERVER}__`));
    const excel = init?.mcpServers.find((server) => server.name === KELLY_EXCEL_MCP_SERVER);
    const answered = result.exitCode === 0 && !result.error && result.response.trim().length > 0;
    return {
      ok: answered && (!kelly || (excel?.status === "connected" && kellyExcelTools.length > 0)),
      provider: "claude",
      ...(init?.model ? { model: init.model } : {}),
      ...(kelly ? { mcpConfig: this.claudeMcpConfig() } : {}),
      mcpServers: init?.mcpServers ?? [],
      kellyExcelTools,
      otherMcpTools: (init?.mcpTools ?? []).filter((tool) => !kellyExcelTools.includes(tool)),
      response: result.response.slice(0, 200),
      ...(result.error ? { error: result.error.slice(0, 500) } : {}),
      durationMs: result.durationMs,
      firstTextMs: result.firstTextMs ?? null,
      ...(providerUsage(result.events, "claude") ? { usage: providerUsage(result.events, "claude") } : {}),
    };
  }

  async run(prompt: string, inputOptions: RunOptions = {}): Promise<RunResult> {
    // PUBLIC RAIL: a process that already serves a public turn never starts another run, and a
    // public run never carries a session, schema, or catalogue retrieval of its own.
    if (isPublicTurn() && !inputOptions.publicTurn) {
      return { runId: randomUUID(), provider: inputOptions.provider || this.config.provider, response: "", exitCode: null, durationMs: 0, error: PUBLIC_TURN_NESTED_REFUSAL, events: [] };
    }
    const options: RunOptions = inputOptions.publicTurn
      ? { ...inputOptions, readOnly: true, surface: undefined, session: undefined, outputSchemaPath: undefined, catalogueQuery: undefined }
      : inputOptions;
    if (options.publicTurn && !options.cwd) throw new Error("A public turn needs an explicit scratch cwd.");
    const at = this.nowFn();
    const ledger = this.limits();
    const policy = readFallbackPolicy(this.settingsPath());
    // A caller-set provider is a PIN (a billing/policy decision) unless the caller marks it soft
    // (RunOptions.pin) — see readFallbackPolicy. `config.provider` is only the default. Read-only
    // runs roam too: Claude runs them under dontAsk with a read-only tool allowlist (claudeArgs),
    // the counterpart of Codex's read-only sandbox.
    const isPinned = options.provider !== undefined && options.pin !== "soft";
    const preferred = options.provider || this.config.provider;
    const alternate: ProviderName = preferred === "codex" ? "claude" : "codex";
    // config.failover: unset → the settings policy alone (Henry profile); "off" → never; a
    // provider name → only that provider may take over (Kelly: KELLY_FAILOVER=codex).
    const failoverAllowed = this.config.failover === undefined || this.config.failover === alternate;
    const roams = !options.publicTurn && failoverAllowed && policy.fallback
      && (!isPinned || (options.pin !== "hard" && policy.fallbackPinned));
    // A public turn never fails over: one provider, one locked-down attempt.
    const sequence: ProviderName[] = roams ? [preferred, alternate] : [preferred];

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
      // Single source of truth for the fields buildProviderArgs and resolveProviderRoute
      // both need — these two calls had drifted apart before (11 fields written out twice).
      const routing = {
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
        claudeEffort: this.config.claudeEffort,
        claudeT0Effort: this.config.claudeT0Effort,
        claudeT2Effort: this.config.claudeT2Effort,
      };
      const route = resolveProviderRoute(provider, routing);
      const readOnly = options.readOnly === true;
      const claudeExtras = provider === "claude" && !options.publicTurn ? this.claudeRunExtras(readOnly) : {};
      const publicModel = options.publicTurn ? options.publicTurn.models?.[provider] ?? route.model : undefined;
      const args = options.publicTurn
        ? (provider === "claude"
          ? publicClaudeArgs(prompt, options.publicTurn.systemPrompt, { model: publicModel, effort: "low" })
          : publicCodexArgs(`${options.publicTurn.systemPrompt}\n\n${prompt}`, { model: publicModel, effort: "low" }))
        : buildProviderArgs(provider, prompt, {
          ...routing,
          readOnly,
          session,
          outputSchemaPath: options.outputSchemaPath,
          ...(provider === "claude" ? {
            // Every Claude brain run streams JSON: the result event is the answer, it carries
            // usage and is_error, and the init event proves which MCP servers loaded.
            claudeStreamJson: true,
            claudePartialMessages: options.partialMessages ?? options.onEvent !== undefined,
            claudeJsonSchema: options.outputSchemaPath ? compactSchema(options.outputSchemaPath) : undefined,
            claudeAllowedTools: claudeExtras.readTools,
            claudeMcpConfigPath: claudeExtras.claudeMcpConfigPath,
            claudeStrictMcp: claudeExtras.claudeStrictMcp,
            claudeSettingSources: claudeExtras.claudeSettingSources,
          } : {}),
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
            cwd, tier: route.tier, requestedTier: options.tier ?? null, model: (options.publicTurn ? publicModel : route.model) ?? null,
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
          cwd, tier: route.tier, requestedTier: options.tier ?? null, model: (options.publicTurn ? publicModel : route.model) ?? null,
          ...(provider === "claude" && route.effort ? { effort: route.effort } : {}),
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
      if (options.publicTurn) {
        // Output-side rail: an answer produced with a tool call (or with a tool merely loaded) is
        // never handed to a visitor. This is configuration drift, not a quota problem, so it
        // neither fails over nor parks the provider.
        const violation = publicTurnViolation(provider, result.events);
        if (violation) {
          result = { ...result, response: "", error: `public sandbox violation: ${violation}` };
          await this.activity.record("run.failed", "Public turn discarded: sandbox violation", { error: result.error, public: true }, { runId: result.runId, provider, role: options.role });
          return result;
        }
      }
      if (isAuthFailureRun(result)) {
        // A "you're logged out" run is a FAILURE, not success — whether the CLI exited cleanly
        // with the notice as its body or failed with it — so the caller never mistakes it for
        // real output, and the next provider in sequence (if any) gets a turn.
        const authError = `${provider} session logged out — run \`${reloginCommand(provider)}\` to re-auth`;
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
            `⚠️ ${provider} session logged out — run \`${reloginCommand(provider)}\` to re-auth. ${fallbackNote}`,
            `${getActiveProfile().name} needs re-login`,
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
      // A Claude `result` with is_error exits 0 but carries an error: never an answer.
      const answered = result.exitCode === 0 && !result.error && result.response.trim().length > 0;
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
        const usage = providerUsage(result.events, provider);
        await this.activity.record("run.completed", `${provider} completed`, {
          durationMs: result.durationMs,
          firstEventMs: result.firstEventMs ?? null,
          firstTextMs: result.firstTextMs ?? null,
          tier: options.tier,
          model: (options.publicTurn ? publicModel : route.model) ?? null,
          ...(usage ? { usage } : {}),
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
          if (shouldNotifyLimit(provider)) {
            void this.notifyFn(
              `⚠️ ${provider} is out of quota until ${entry.until}. ${next} is taking over.`,
              `${getActiveProfile().name} switched provider`,
            ).catch(() => undefined);
          }
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
      // A writable run that already produced output may have edited files or called tools.
      // Re-running the same prompt on the other CLI could apply that work twice, so hand back
      // the partial result instead. Quota, logout and refused spawns are handled above.
      if (next && !options.readOnly && result.events.some((event) => event.stream === "stdout")) {
        await this.activity.record(
          "run.failed",
          `${provider} failed mid-run; not re-running a writable task on ${next}`,
          { error: result.error, partial: true },
          { runId: result.runId, provider, role: options.role },
        );
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
