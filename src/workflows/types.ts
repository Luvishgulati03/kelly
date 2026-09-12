import type { DispatchTier, ProviderName, RunResult } from "../types.ts";
import type { RunOptions } from "../providers/runner.ts";

/** A trigger that fires the workflow on a cron schedule (croner syntax). */
export interface WorkflowScheduleTrigger {
  type: "schedule";
  cron: string;
  timezone?: string;
}

/** A trigger that exposes the workflow under `henry workflow run <command>`. */
export interface WorkflowCommandTrigger {
  type: "command";
  command: string;
}

export type WorkflowTrigger = WorkflowScheduleTrigger | WorkflowCommandTrigger;

/** Where a run's artifact lands. Only markdown docs artifacts exist today. */
export interface WorkflowDocsOutput {
  type: "docs";
  path: string;
}

export type WorkflowOutput = WorkflowDocsOutput;

export interface WorkflowRunnerConfig {
  provider?: ProviderName;
  /** Dispatch tier per MASTER_PLAN §11.1; selects the provider model/effort flags. */
  tier?: DispatchTier;
  timeoutMs?: number;
}

/** A parsed `workflows/<name>.workflow.md` file: frontmatter config + prompt body. */
export interface WorkflowFile {
  name: string;
  enabled: boolean;
  description: string;
  triggers: WorkflowTrigger[];
  outputs: WorkflowOutput[];
  runner?: WorkflowRunnerConfig;
  concurrency?: "skip" | "parallel";
  body: string;
  /** Absolute path the workflow was loaded from (set by the loader, not the frontmatter). */
  sourcePath?: string;
}

export interface WorkflowParseResult {
  ok: boolean;
  workflow?: WorkflowFile;
  errors: string[];
}

/**
 * The slice of ProviderRunner the executor depends on, so tests can inject a fake
 * and never spawn a provider subprocess.
 */
export interface WorkflowProviderRunner {
  run(prompt: string, options?: RunOptions): Promise<RunResult>;
}

export interface WorkflowRunResult {
  workflow: string;
  runId: string;
  reason: string;
  status: "completed" | "failed" | "skipped";
  artifactPath?: string;
  response?: string;
  error?: string;
  durationMs: number;
}
