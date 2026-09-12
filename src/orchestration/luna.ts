import type { ActivityLog } from "../activity.ts";
import type { HenryConfig } from "../config.ts";
import type { HenryMemory } from "../memory/engram.ts";
import type { DispatchTier, ProviderEvent, ProviderName, RunResult } from "../types.ts";
import { ProviderRunner } from "../providers/runner.ts";
import { sharedAdmissionController } from "./admission.ts";
import { sharedAgentRegistry } from "./agent-registry.ts";

export const SPECIALISTS = {
  architect: "Design boundaries, data flow, and sequencing. Do not edit unrelated files.",
  runtime: "Own Codex/Claude execution, subprocess lifecycle, streaming, and failure recovery.",
  memory: "Own the actual Engram integration, indexing, recall traces, graph, and dreaming.",
  dashboard: "Own local dashboard state, APIs, approvals, activity, and clear operator UX.",
  gmail: "Own Gmail OAuth, inbox reading, drafts, polling, and approval-gated outbound actions.",
  "pr-review": "Own the six-pass PR review workflow, re-review behavior, findings, and staged GitHub comments.",
  "job-application": "Own job posting inspection, truthful tailoring of resumes and answers, form filling for review, and the approval-gated submission boundary. Never invent candidate facts and never bypass site protections.",
  qa: "Own tests, type safety, security boundaries, and verification of the whole agent.",
  research: "Own long-form, source-grounded research. Use primary sources where possible, distinguish sourced facts from inference, include links and dates, and return a decision-ready report.",
} as const;

export type SpecialistRole = keyof typeof SPECIALISTS;

/** Short outcome text for the agent registry: first non-empty line of a provider response. */
function firstLine(text: string): string | undefined {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0)?.trim();
  return line;
}

/** Default tier per specialist (§11.2: lowest tier that clears the quality bar). */
const ROLE_TIER: Partial<Record<SpecialistRole, DispatchTier>> = {
  architect: "t2",
  "pr-review": "t2",
  // The coordinator is deliberately Sol at low reasoning. Research depth comes
  // from tool use and source synthesis, not from keeping Henry's foreground
  // brain occupied or raising every research request to Luna/high.
  research: "t1",
};

export const DISPATCH_ACKNOWLEDGEMENT = "Started — I'll report back.";

const EXPLICIT_LONG_RESEARCH = /\b(deep|in[- ]depth|thorough|comprehensive|full[- ]fledged|extensive|detailed)\s+(?:web\s+)?research\b|\bresearch\s+(?:this|it|the\s+topic)?\s*(?:deeply|thoroughly|in[- ]depth)\b/i;
const RESEARCH_NOUN = /\b(research|literature review|market scan|competitive analysis|source analysis)\b/i;
const LONG_FORM_OUTPUT = /\b(report|brief|memo|landscape|compare|comparison|recommendation|recommendations|plan|strategy|sources?|citations?)\b/i;

/**
 * Cheap, auditable routing gate. A plain "look this up" remains a normal Henry
 * turn; explicit depth language, or a substantial research+deliverable ask,
 * becomes dispatch-and-report without spending another model call on routing.
 */
export function isLongResearchAsk(prompt: string): boolean {
  const text = prompt.trim();
  if (!text) return false;
  if (EXPLICIT_LONG_RESEARCH.test(text)) return true;
  return text.length >= 180 && RESEARCH_NOUN.test(text) && LONG_FORM_OUTPUT.test(text);
}

export interface DispatchOptions {
  allowEdits?: boolean;
  cwd?: string;
  /** §11.1 tier knob; defaults to the role's tier, else the configured models. */
  tier?: DispatchTier;
  /** §7 wall-clock envelope for the dispatched worker. */
  timeoutMs?: number;
  /** Optional provider pin and stream sink for surfaced dispatch-and-report work. */
  provider?: ProviderName;
  onEvent?: (event: ProviderEvent) => void;
}

export interface DispatchReportHandle {
  acknowledgement: typeof DISPATCH_ACKNOWLEDGEMENT;
  completion: Promise<RunResult>;
}

export class LunaOrchestrator {
  private readonly runner: ProviderRunner;

  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    private readonly memory: HenryMemory,
  ) {
    // One admission controller for the whole process: Luna's dispatches, the
    // agent's own runs, and scheduled workflows all draw on the same 2-slot budget.
    this.runner = new ProviderRunner(config, activity, sharedAdmissionController());
  }

  async dispatch(role: string, task: string, options: DispatchOptions = {}): Promise<Awaited<ReturnType<ProviderRunner["run"]>>> {
    const selected = (role in SPECIALISTS ? role : "architect") as SpecialistRole;
    const prompt = [
      `You are Luna's ${selected} specialist working on Henry.`,
      SPECIALISTS[selected],
      options.allowEdits ? "You may edit only files needed for this task and must report changed files." : "This is an investigation pass. Do not edit files; return an implementation memo with concrete next actions.",
      "Keep outbound communication staged; never post messages or comments directly.",
      `Task from Luvish: ${task}`,
    ].join("\n\n");
    const tier = options.tier ?? ROLE_TIER[selected];
    // Registry bookkeeping is dashboard display only (§ dispatch-registry): never
    // let it change dispatch's behaviour/return value or slow/break a real run, so
    // every touch point is wrapped and failures are swallowed (fail open).
    const registry = sharedAgentRegistry();
    let agentId: string | null = null;
    const requestedProvider = options.provider ?? this.config.provider;
    try { agentId = registry.start(selected, task, requestedProvider); } catch { /* best effort */ }
    try {
      const result = await this.runner.run(prompt, {
        cwd: options.cwd || this.config.rootDir,
        role: selected,
        // Resumable workers: each specialist role rides a per-surface provider session,
        // so a disconnected worker's context survives restarts — the next dispatch of
        // the same role resumes the same provider session instead of starting cold.
        surface: `luna::${selected}`,
        readOnly: !options.allowEdits,
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
        ...(tier ? { tier } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
      try {
        if (agentId) {
          const ok = result.exitCode === 0;
          registry.settle(agentId, ok ? "done" : "failed", {
            provider: result.provider,
            summary: ok ? firstLine(result.response) : (result.error ?? `exit ${String(result.exitCode)}`),
          });
        }
      } catch { /* best effort */ }
      await this.activity.record("agent.dispatched", `Luna dispatched ${selected}`, { task, provider: result.provider, tier, success: result.exitCode === 0 }, { runId: result.runId, role: selected, provider: result.provider });
      if (result.response) await this.memory.remember(`Luna dispatched ${selected} for: ${task}\n\nResult:\n${result.response}`, { tier: "procedural", importance: 6, metadata: { role: selected, runId: result.runId } });
      return result;
    } catch (error) {
      try { if (agentId) registry.settle(agentId, "failed", { summary: error instanceof Error ? error.message : String(error) }); } catch { /* best effort */ }
      throw error;
    }
  }

  /**
   * Starts long research on the next microtask so the caller can render/send
   * the acknowledgement before any provider event arrives. Pinning Codex+t1
   * resolves to the configured gpt-5.6-sol model with low reasoning effort.
   */
  dispatchAndReport(task: string, options: Omit<DispatchOptions, "tier" | "provider" | "allowEdits"> = {}): DispatchReportHandle {
    const completion = Promise.resolve().then(() => this.dispatch("research", task, {
      ...options,
      allowEdits: false,
      provider: "codex",
      tier: "t1",
    }));
    return { acknowledgement: DISPATCH_ACKNOWLEDGEMENT, completion };
  }

  /**
   * Parallel dispatch is safe because admission control serializes the actual
   * spawns to the M1 budget (§7) — the extra tasks simply queue.
   */
  async dispatchMany(tasks: Array<{ role: string; task: string } & DispatchOptions>): Promise<Array<Awaited<ReturnType<ProviderRunner["run"]>>>> {
    return Promise.all(tasks.map(({ role, task, ...options }) => this.dispatch(role, task, options)));
  }
}
