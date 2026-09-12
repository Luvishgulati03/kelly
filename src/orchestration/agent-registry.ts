import { randomUUID } from "node:crypto";

/**
 * In-flight / recently-finished dispatch tracking for the dashboard (see
 * LunaOrchestrator#dispatch). This is display-only bookkeeping, not a job
 * queue or a source of truth: it lives entirely in process memory (never
 * written to disk) so a restart clears it cleanly instead of leaving stale
 * "running" ghosts behind — there is nothing to reconcile on startup because
 * there is nothing left over. The task string can carry personal content, so
 * it is kept here for local-dashboard display only and never persisted or
 * forwarded anywhere else.
 */

export type AgentStatus = "running" | "done" | "failed";

export interface AgentEntry {
  id: string;
  role: string;
  task: string;
  provider: string;
  startedAt: string;
  finishedAt?: string;
  status: AgentStatus;
  summary?: string;
}

const MAX_TASK_LEN = 200;
const MAX_SUMMARY_LEN = 200;
const MAX_RECENT = 20;
const MAX_LOG = 100;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface LogEntry {
  seq: number;
  entry: AgentEntry;
}

export class AgentRegistry {
  private readonly running = new Map<string, AgentEntry>();
  private readonly recent: AgentEntry[] = [];
  private readonly log: LogEntry[] = [];
  private seq = 0;

  /** Records a dispatch as starting. Returns the entry id used to settle it later. */
  start(role: string, task: string, provider: string): string {
    const entry: AgentEntry = {
      id: randomUUID(),
      role,
      task: truncate(task, MAX_TASK_LEN),
      provider,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    this.running.set(entry.id, entry);
    this.publish(entry);
    return entry.id;
  }

  /** Marks a dispatch settled (success or failure). No-op if the id is unknown (e.g. registry write failure on start). */
  settle(id: string, status: "done" | "failed", options: { summary?: string; provider?: string } = {}): void {
    const inFlight = this.running.get(id);
    if (!inFlight) return;
    this.running.delete(id);
    const settled: AgentEntry = {
      ...inFlight,
      ...(options.provider ? { provider: options.provider } : {}),
      status,
      finishedAt: new Date().toISOString(),
      ...(options.summary ? { summary: truncate(options.summary, MAX_SUMMARY_LEN) } : {}),
    };
    this.recent.unshift(settled);
    while (this.recent.length > MAX_RECENT) this.recent.pop();
    this.publish(settled);
  }

  snapshot(): { running: AgentEntry[]; recent: AgentEntry[] } {
    return { running: [...this.running.values()], recent: [...this.recent] };
  }

  /** Changelog cursor for SSE polling, mirroring how /api/events diffs the activity log. */
  changesSince(sinceSeq: number): { entries: AgentEntry[]; seq: number } {
    const entries = this.log.filter((row) => row.seq > sinceSeq).map((row) => row.entry);
    return { entries, seq: this.seq };
  }

  private publish(entry: AgentEntry): void {
    this.seq += 1;
    this.log.push({ seq: this.seq, entry });
    while (this.log.length > MAX_LOG) this.log.shift();
  }
}

// Module-level singleton, same shape as sharedAdmissionController(): every
// dispatcher records through the same in-memory registry without threading
// it through constructors.
let shared: AgentRegistry | undefined;

export function sharedAgentRegistry(): AgentRegistry {
  if (!shared) shared = new AgentRegistry();
  return shared;
}

/** Test seam: swap (or clear, with `undefined`) the process-wide registry. */
export function setSharedAgentRegistry(registry: AgentRegistry | undefined): void {
  shared = registry;
}
