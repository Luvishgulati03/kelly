import { Cron } from "croner";
import type { ActivityLog } from "../activity.ts";
import type { WorkflowExecutor } from "./executor.ts";
import type { WorkflowRegistry } from "./registry.ts";

interface ArmedJob { workflow: string; cron: Cron; expression: string; timezone?: string }

/**
 * Arms croner jobs for every enabled workflow that declares a schedule trigger.
 * Complements the legacy WorkflowScheduler (workflows/defaults.json kinds) rather
 * than replacing it — one daemon process serves both.
 */
export class WorkflowSchedulerBridge {
  private jobs: ArmedJob[] = [];

  constructor(
    private readonly registry: WorkflowRegistry,
    private readonly executor: WorkflowExecutor,
    private readonly activity: ActivityLog,
  ) {}

  async start(): Promise<Array<{ workflow: string; cron: string; timezone?: string; nextRun?: string }>> {
    this.stop();
    for (const workflow of this.registry.list()) {
      if (!workflow.enabled) continue;
      for (const trigger of workflow.triggers) {
        if (trigger.type !== "schedule") continue;
        try {
          const cron = new Cron(
            trigger.cron,
            { protect: true, ...(trigger.timezone ? { timezone: trigger.timezone } : {}) },
            () => void this.executor.run(workflow, `schedule:${trigger.cron}`),
          );
          this.jobs.push({ workflow: workflow.name, cron, expression: trigger.cron, ...(trigger.timezone ? { timezone: trigger.timezone } : {}) });
        } catch (error) {
          await this.activity.record("workflow.failed", `Could not arm schedule for ${workflow.name}`, {
            workflow: workflow.name, cron: trigger.cron, error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    const armed = this.armed();
    await this.activity.record("workflow.started", `Armed ${armed.length} markdown workflow schedules`, { jobs: armed });
    return armed;
  }

  armed(): Array<{ workflow: string; cron: string; timezone?: string; nextRun?: string }> {
    return this.jobs.map((job) => ({
      workflow: job.workflow, cron: job.expression,
      ...(job.timezone ? { timezone: job.timezone } : {}),
      ...(job.cron.nextRun() ? { nextRun: job.cron.nextRun()?.toISOString() } : {}),
    }));
  }

  stop(): void {
    for (const job of this.jobs) job.cron.stop();
    this.jobs = [];
  }
}
