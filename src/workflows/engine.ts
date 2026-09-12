import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import { WorkflowExecutor } from "./executor.ts";
import { WorkflowRegistry } from "./registry.ts";
import { WorkflowSchedulerBridge } from "./scheduler-bridge.ts";
import type { WorkflowFile, WorkflowProviderRunner, WorkflowRunResult } from "./types.ts";

/**
 * The markdown workflow engine: registry (hot-reloaded `*.workflow.md`) + executor
 * (provider run → artifact) + scheduler bridge (croner). Construction is cheap and
 * side-effect free; `start()` is what watches the filesystem and arms crons, so the
 * runtime can expose the engine lazily and only daemons pay for it.
 */
export class WorkflowEngine {
  readonly registry: WorkflowRegistry;
  readonly executor: WorkflowExecutor;
  readonly bridge: WorkflowSchedulerBridge;
  private started = false;

  constructor(config: HenryConfig, activity: ActivityLog, runner: WorkflowProviderRunner) {
    this.registry = new WorkflowRegistry(config.workflowsDir, activity);
    this.executor = new WorkflowExecutor(config, activity, runner);
    this.bridge = new WorkflowSchedulerBridge(this.registry, this.executor, activity);
  }

  /** Rescans the workflow directory without watching or arming anything. */
  async load(): Promise<WorkflowFile[]> { return await this.registry.load(); }

  /** Daemon entry point: load, watch for edits, arm schedules (re-arming on every reload). */
  async start(): Promise<Array<{ workflow: string; cron: string; timezone?: string; nextRun?: string }>> {
    if (this.started) return this.bridge.armed();
    this.started = true;
    await this.registry.load();
    this.registry.onChange(() => { void this.bridge.start(); });
    this.registry.watch();
    return await this.bridge.start();
  }

  get(name: string): WorkflowFile | undefined {
    return this.registry.get(name)
      ?? this.registry.list().find((workflow) => workflow.triggers.some((trigger) => trigger.type === "command" && trigger.command === name));
  }

  async run(name: string, reason = "manual"): Promise<WorkflowRunResult> {
    if (!this.registry.list().length) await this.load();
    const workflow = this.get(name);
    if (!workflow) throw new Error(`Workflow not found: ${name}`);
    return await this.executor.run(workflow, reason);
  }

  /** Artifact paths for a workflow, newest first. */
  async artifacts(name: string): Promise<string[]> {
    if (!this.registry.list().length) await this.load();
    const workflow = this.get(name);
    if (!workflow) throw new Error(`Workflow not found: ${name}`);
    return await this.executor.artifacts(workflow);
  }

  stop(): void {
    this.bridge.stop();
    this.registry.stop();
    this.started = false;
  }
}

export { WorkflowRegistry } from "./registry.ts";
export { WorkflowExecutor } from "./executor.ts";
export { WorkflowSchedulerBridge } from "./scheduler-bridge.ts";
export * from "./types.ts";
