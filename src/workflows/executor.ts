import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import { WORKFLOW_RUNS_ROOT, isAllowedDocsPath } from "./definition.ts";
import type { WorkflowFile, WorkflowProviderRunner, WorkflowRunResult } from "./types.ts";

export const RUNTIME_CONTEXT_HEADER = "--- runtime context (source of truth) ---";

function today(): string { return new Date().toISOString().slice(0, 10); }

/** Runs workflow bodies as provider prompts and writes each run's artifact to disk. */
export class WorkflowExecutor {
  private readonly running = new Set<string>();

  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    private readonly runner: WorkflowProviderRunner,
  ) {}

  /** Resolves (and re-verifies) the artifact directory a workflow may write to. */
  artifactDir(workflow: WorkflowFile): string {
    const declared = workflow.outputs.find((output) => output.type === "docs")?.path;
    const relative = declared && isAllowedDocsPath(declared, workflow.name)
      ? declared
      : `${WORKFLOW_RUNS_ROOT}/${workflow.name}`;
    const base = path.resolve(this.config.rootDir, WORKFLOW_RUNS_ROOT, workflow.name);
    const resolved = path.resolve(this.config.rootDir, relative);
    // Defence in depth: the parser already rejected traversal, this guarantees it.
    return resolved === base || resolved.startsWith(`${base}${path.sep}`) ? resolved : base;
  }

  /** Lists a workflow's artifacts, newest first. */
  async artifacts(workflow: WorkflowFile): Promise<string[]> {
    const dir = this.artifactDir(workflow);
    try {
      const entries = (await fs.readdir(dir)).filter((entry) => entry.endsWith(".md"));
      const stats = await Promise.all(entries.map(async (entry) => {
        const filePath = path.join(dir, entry);
        return { filePath, mtime: (await fs.stat(filePath)).mtimeMs };
      }));
      return stats.sort((a, b) => b.mtime - a.mtime).map((item) => item.filePath);
    } catch { return []; }
  }

  async run(workflow: WorkflowFile, reason: string): Promise<WorkflowRunResult> {
    const runId = randomUUID().slice(0, 8);
    const started = Date.now();
    const concurrency = workflow.concurrency ?? "skip";
    if (concurrency === "skip" && this.running.has(workflow.name)) {
      await this.activity.record("workflow.started", `Workflow ${workflow.name} skipped: already running`, { workflow: workflow.name, reason });
      return { workflow: workflow.name, runId, reason, status: "skipped", durationMs: 0 };
    }
    this.running.add(workflow.name);

    const dir = this.artifactDir(workflow);
    const artifactPath = path.join(dir, `${today()}-${runId}.md`);
    const context = {
      run: { id: runId, reason, artifactPath },
      henry: { rootDir: this.config.rootDir, dataDir: this.config.dataDir },
      workflow: { name: workflow.name, description: workflow.description },
    };
    const prompt = `${RUNTIME_CONTEXT_HEADER}\n${JSON.stringify(context, null, 2)}\n\n${workflow.body}`;

    await this.activity.record("workflow.started", `Workflow ${workflow.name} started (${reason})`, {
      workflow: workflow.name, runId, reason, tier: workflow.runner?.tier, artifactPath,
    });

    try {
      const result = await this.runner.run(prompt, {
        role: `workflow:${workflow.name}`,
        readOnly: false,
        ...(workflow.runner?.provider ? { provider: workflow.runner.provider } : {}),
        ...(workflow.runner?.tier ? { tier: workflow.runner.tier } : {}),
        ...(workflow.runner?.timeoutMs ? { timeoutMs: workflow.runner.timeoutMs } : {}),
      });
      const failed = result.exitCode !== 0 || !result.response.trim();
      const body = result.response.trim() || result.error || "The provider returned no output.";
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        artifactPath,
        [
          `# ${workflow.name} — ${new Date().toISOString()}`, "",
          `- run: ${runId}`, `- reason: ${reason}`, `- provider: ${result.provider}`,
          `- status: ${failed ? "failed" : "completed"}`, "", body, "",
        ].join("\n"),
        { encoding: "utf8", mode: 0o600 },
      );
      const durationMs = Date.now() - started;
      if (failed) {
        await this.activity.record("workflow.failed", `Workflow ${workflow.name} failed`, {
          workflow: workflow.name, runId, error: result.error, artifactPath,
        });
        return { workflow: workflow.name, runId, reason, status: "failed", artifactPath, error: result.error ?? "empty provider response", durationMs };
      }
      await this.activity.record("workflow.completed", `Workflow ${workflow.name} completed`, {
        workflow: workflow.name, runId, artifactPath, durationMs,
      });
      return { workflow: workflow.name, runId, reason, status: "completed", artifactPath, response: result.response, durationMs };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.activity.record("workflow.failed", `Workflow ${workflow.name} failed`, { workflow: workflow.name, runId, error: message });
      return { workflow: workflow.name, runId, reason, status: "failed", error: message, durationMs: Date.now() - started };
    } finally {
      this.running.delete(workflow.name);
    }
  }
}
