/**
 * Shared provider-free reflex lane for every interactive surface.
 *
 * Keep this vocabulary narrow: these questions have complete, unambiguous
 * answers in Henry's local runtime state. Anything requiring interpretation,
 * external facts, or judgment belongs to the configured model.
 */
export interface ReflexSnapshot {
  running: Array<{ role: string; task: string; startedAt: string }>;
  recentDone: number;
  pendingApprovals: number;
  provider: string;
  uptimeSec?: number;
}

export type ReflexKind = "working" | "pending" | "alive";

const REFLEX_PATTERNS: Array<[RegExp, ReflexKind]> = [
  [/^\s*(what(?:'?s| is| are you)?\s+(you\s+)?(doing|working on|up to)|any\s+agents?\s+running|agent\s+status|what'?s\s+running)\s*\??\s*$/i, "working"],
  [/^\s*(anything\s+)?(pending|waiting|to\s+approve|approvals?)\s*\??\s*$/i, "pending"],
  [/^\s*(are\s+you\s+(there|up|alive|awake)|you\s+(there|up|alive)|status|ping)\s*\??\s*$/i, "alive"],
];

export function reflexKind(text: string): ReflexKind | undefined {
  for (const [pattern, kind] of REFLEX_PATTERNS) if (pattern.test(text)) return kind;
  return undefined;
}

function agoLabel(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return "just now";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

export function renderReflex(kind: ReflexKind, snapshot: ReflexSnapshot, now: number): string {
  if (kind === "working") {
    if (snapshot.running.length === 0) {
      return snapshot.recentDone > 0
        ? `Nothing running right now — ${snapshot.recentDone} finished recently.`
        : "Nothing running right now.";
    }
    const lines = snapshot.running.map((agent) => `• ${agent.role} — ${agent.task} (${agoLabel(agent.startedAt, now)})`);
    return [`Running ${snapshot.running.length}:`, ...lines].join("\n");
  }
  if (kind === "pending") {
    return snapshot.pendingApprovals === 0
      ? "Nothing waiting on you."
      : `${snapshot.pendingApprovals} waiting on your approval.`;
  }
  const busy = snapshot.running.length > 0 ? `, ${snapshot.running.length} running` : "";
  return `Here — on ${snapshot.provider}${busy}.`;
}
