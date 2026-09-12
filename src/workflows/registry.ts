import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { ActivityLog } from "../activity.ts";
import { WORKFLOW_SUFFIX, loadWorkflowFile } from "./definition.ts";
import type { WorkflowFile } from "./types.ts";

const DEBOUNCE_MS = 500;

/**
 * Loads every `workflows/*.workflow.md` and hot-reloads them on change.
 *
 * Last-known-good policy: when a file stops parsing (mid-edit save, typo), the
 * previously valid version stays armed and the errors are recorded to the activity
 * log. A workflow only leaves the registry when its file is deleted.
 */
export class WorkflowRegistry {
  private workflows = new Map<string, WorkflowFile>();
  private invalid = new Map<string, string[]>();
  private watcher?: fsSync.FSWatcher;
  private debounce?: NodeJS.Timeout;
  private listeners: Array<(workflows: WorkflowFile[]) => void> = [];

  constructor(private readonly directory: string, private readonly activity?: ActivityLog) {}

  /** Full rescan of the workflow directory. Returns the currently valid workflows. */
  async load(): Promise<WorkflowFile[]> {
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(this.directory)).filter((entry) => entry.endsWith(WORKFLOW_SUFFIX)).sort();
    } catch { entries = []; }

    const seen = new Set<string>();
    for (const entry of entries) {
      const filePath = path.join(this.directory, entry);
      const result = await loadWorkflowFile(filePath);
      const name = entry.slice(0, -WORKFLOW_SUFFIX.length);
      seen.add(name);
      if (result.ok && result.workflow) {
        this.workflows.set(result.workflow.name, result.workflow);
        this.invalid.delete(name);
        continue;
      }
      const previous = JSON.stringify(this.invalid.get(name) ?? []);
      if (previous !== JSON.stringify(result.errors)) {
        this.invalid.set(name, result.errors);
        await this.activity?.record(
          "workflow.failed",
          this.workflows.has(name)
            ? `Workflow ${name} failed to parse; keeping the last known good version`
            : `Workflow ${name} failed to parse and has no known good version`,
          { workflow: name, errors: result.errors },
        );
      }
    }

    for (const name of [...this.workflows.keys()]) if (!seen.has(name)) this.workflows.delete(name);
    for (const name of [...this.invalid.keys()]) if (!seen.has(name)) this.invalid.delete(name);
    return this.list();
  }

  /** Starts fs.watch with a 500ms debounce; every event triggers a full rescan. */
  watch(): void {
    if (this.watcher) return;
    try {
      this.watcher = fsSync.watch(this.directory, { persistent: false }, () => {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => { void this.reload(); }, DEBOUNCE_MS);
      });
    } catch { /* Directory missing: nothing to watch until it exists. */ }
  }

  private async reload(): Promise<void> {
    const workflows = await this.load();
    for (const listener of this.listeners) listener(workflows);
  }

  onChange(listener: (workflows: WorkflowFile[]) => void): void { this.listeners.push(listener); }

  get(name: string): WorkflowFile | undefined { return this.workflows.get(name); }

  list(): WorkflowFile[] { return [...this.workflows.values()].sort((a, b) => a.name.localeCompare(b.name)); }

  /** Parse errors for files that are currently invalid, keyed by workflow name. */
  problems(): Record<string, string[]> { return Object.fromEntries(this.invalid); }

  stop(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = undefined;
    this.watcher?.close();
    this.watcher = undefined;
  }
}
