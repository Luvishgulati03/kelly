export type ProviderName = "codex" | "claude";

/**
 * Dispatch tier (MASTER_PLAN §11.1): t0 = nano/triage, t1 = standard
 * implementation, t2 = frontier reasoning. Subscription CLIs only — tiers map
 * to CLI model/effort flags, never to API calls.
 */
export type DispatchTier = "t0" | "t1" | "t2";

export type ActivityKind =
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "provider.failover"
  | "provider.preflight-switch"
  | "agent.dispatched"
  | "memory.recalled"
  | "memory.saved"
  | "approval.created"
  | "approval.approved"
  | "approval.executed"
  | "workflow.started"
  | "workflow.completed"
  | "workflow.failed"
  | "gmail.read"
  | "pr.reviewed"
  | "pr.merged"
  | "pr.verified"
  | "pr.rollback-staged"
  | "job.discovered"
  | "job.prepared"
  | "job.filled"
  | "job.submitted"
  | "job.submission_uncertain"
  | "job.fill_retry"
  | "resume.generated"
  | "provider.switched"
  | "task.started"
  | "task.completed"
  | "social.drafted"
  | "social.posted"
  | "gmail.drafted";

export interface ActivityEvent {
  id: string;
  timestamp: string;
  kind: ActivityKind;
  message: string;
  runId?: string;
  role?: string;
  provider?: ProviderName;
  metadata?: Record<string, unknown>;
}

export interface RunResult {
  runId: string;
  provider: ProviderName;
  response: string;
  exitCode: number | null;
  durationMs: number;
  error?: string;
  events: ProviderEvent[];
  /** Latency §11.5 round 2: ms from spawn to the first stdout event; null if none arrived before completion. Absent on synthetic results that never spawned a process. */
  firstEventMs?: number | null;
  /** Latency §11.5 round 2: ms from spawn to the first event whose parsed payload carried text; null if none arrived before completion. Absent on synthetic results that never spawned a process. */
  firstTextMs?: number | null;
  /**
   * The run produced nothing because every candidate provider was out of quota — NOT because
   * the work failed. Callers must be able to tell those apart: a limited run is worth keeping
   * and resuming when capacity returns, while a broken one is not. Without this the refusal
   * was indistinguishable from an empty answer, and a Telegram turn was silently discarded.
   */
  limited?: boolean;
}

export interface ProviderEvent {
  timestamp: string;
  stream: "stdout" | "stderr" | "system";
  text: string;
  parsed?: Record<string, unknown>;
}

export interface ApprovalItem {
  id: string;
  createdAt: string;
  updatedAt: string;
  kind: "gmail.send" | "github.review" | "github.merge" | "github.rollback" | "message.send" | "job.application" | "social.x-post";
  status: "pending" | "approved" | "executing" | "executed" | "rejected" | "failed";
  title: string;
  recipient?: string;
  subject?: string;
  body: string;
  payload: Record<string, unknown>;
  result?: string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  cron: string;
  kind: "memory.dream" | "gmail.inbox" | "agent.prompt" | "knowledge.distill" | "mail.watch" | "standup.prompt" | "standup.scan" | "standup.summary" | "portfolio.stats" | "mail.digest" | "jobs.scout" | "social.tweet" | "backup.private";
  /** Standup kinds only: which daily cycle this entry drives (default "morning"). */
  session?: "morning" | "evening";
  enabled: boolean;
  prompt?: string;
  /** knowledge.distill only: modules distilled into strategy cards per run (default 15 in the scheduler). */
  batchLimit?: number;
}

export interface ReviewFinding {
  severity: "blocker" | "warning" | "nit";
  title: string;
  body: string;
  path: string;
  line: number;
  side?: "RIGHT" | "LEFT";
}

export interface ReviewReport {
  id: string;
  repository: string;
  pullRequest: number;
  url?: string;
  verdict: "approved" | "changes-requested" | "blocker";
  summary: string;
  findings: ReviewFinding[];
  passes: Record<string, string>;
  generatedAt: string;
  provider: ProviderName;
  /** Number of model findings suppressed because Henry already posted them. */
  suppressedFindings?: number;
  /** Breakdown of suppressed findings, retained separately for backward compatibility. */
  suppressedFindingBreakdown?: { identical: number; reworded: number };
  approvalId?: string;
  headSha?: string;
}

export interface ProjectCheckResult {
  command: string;
  cwd: string;
  passed: boolean;
  exitCode: number | null;
  output: string;
}

export interface PullRequestMergePlan {
  repository: string;
  pullRequest: number;
  title: string;
  headSha: string;
  baseBranch?: string;
  cwd: string;
  mergeMethod: "merge" | "squash" | "rebase";
  checkCommand: string;
  verifyCommand: string;
  check: ProjectCheckResult;
}
