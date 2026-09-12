import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LaunchAnswer, LaunchIntakeRecord, LaunchPhase, LaunchQuestion, LaunchSynthesis } from "./types.ts";

/** `run()` refuses below this many answered questions (MASTER_PLAN §6.3 build spec). */
export const MIN_ANSWERED_QUESTIONS = 3;

export function slugifyLaunch(value: string): string {
  const trimmed = value.trim();
  const base = /[\\/]/.test(trimmed) ? path.basename(trimmed.replace(/[\\/]+$/, "")) : trimmed;
  return base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "launch";
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * Distinguishes "a repo path" from "a product brief" by trying it on disk — more reliable
 * than a regex heuristic. Drives intake(): a repo gets a read-only codex investigation
 * (cwd = the path); a brief is reasoned from text alone.
 */
export async function resolveLaunchSource(
  input: string,
  rootDir: string,
): Promise<{ kind: "repo"; path: string } | { kind: "brief" }> {
  const trimmed = input.trim();
  if (!trimmed || trimmed.includes("\n") || trimmed.length > 300) return { kind: "brief" };
  const candidate = trimmed.startsWith("~") ? path.resolve(expandHome(trimmed)) : path.resolve(rootDir, trimmed);
  try {
    const info = await stat(candidate);
    if (info.isFile() || info.isDirectory()) return { kind: "repo", path: candidate };
  } catch { /* not a real path on disk -- treat as a product brief */ }
  return { kind: "brief" };
}

function extractJsonObject(raw: string): Record<string, unknown> {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || raw;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Model did not return JSON");
  return JSON.parse(fenced.slice(start, end + 1)) as Record<string, unknown>;
}

export function parseIntakeResponse(raw: string): { productSummary: string; questions: LaunchQuestion[] } {
  const parsed = extractJsonObject(raw);
  const productSummary = typeof parsed.productSummary === "string" && parsed.productSummary.trim()
    ? parsed.productSummary.trim() : "No product summary returned.";
  const questionsRaw = Array.isArray(parsed.questions) ? parsed.questions : [];
  const questions: LaunchQuestion[] = [];
  for (const item of questionsRaw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.text !== "string" || !record.text.trim()) continue;
    questions.push({
      text: record.text.trim(),
      citation: typeof record.citation === "string" && record.citation.trim() ? record.citation.trim() : null,
    });
  }
  if (!questions.length) throw new Error("Launch intake did not return any questions");
  return { productSummary, questions };
}

export function parseSynthesisResponse(raw: string): LaunchSynthesis {
  const parsed = extractJsonObject(raw);
  const field = (key: string, fallback: string): string => {
    const value = parsed[key];
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  };
  return {
    strategy: field("strategy", "No strategy returned."),
    auditStatus: field("auditStatus", "No audit status returned."),
    competitiveGaps: field("competitiveGaps", "No competitive analysis returned."),
    roadmap: field("roadmap", "No roadmap returned."),
    openRisks: field("openRisks", "No risks returned."),
  };
}

export function renderIntakeMarkdown(record: LaunchIntakeRecord): string {
  const source = record.sourceKind === "repo" ? `repository at ${record.sourcePath}` : "product brief (no repository path given)";
  const citationsBlock = record.citations.length
    ? record.citations.map((c) => `- ${c}`).join("\n")
    : "- No playbooks matched yet (questions below use general product-launch judgment).";
  const questionsBlock = record.questions.map((q, i) => {
    const cite = q.citation ? ` (cites: ${q.citation})` : "";
    return `${i + 1}. ${q.text}${cite}\n   ANSWER:`;
  }).join("\n\n");
  return [
    `# Launch intake: ${record.slug}`,
    "",
    `**Source:** ${source}`,
    `**Created:** ${record.createdAt}`,
    "**Status:** intake-pending-answers",
    "",
    "## Product summary",
    "",
    record.productSummary,
    "",
    "## Recalled playbooks",
    "",
    citationsBlock,
    "",
    "## Questions for Luvish",
    "",
    `Fill in each ANSWER: line below (write the answer on the same line, after the colon). Save this file, then run: henry launch run ${record.slug}`,
    `At least ${MIN_ANSWERED_QUESTIONS} questions must be answered before the crew will run.`,
    "",
    questionsBlock,
    "",
  ].join("\n");
}

/**
 * Parses Luvish's hand-edited intake.md back into Q/A pairs. Tolerant of formatting drift:
 * any "N. <text>" line opens a question, the next "ANSWER: <text>" line (case-insensitive)
 * closes it — everything else on the file is ignored.
 */
export function parseAnsweredQuestions(intakeMarkdown: string): LaunchAnswer[] {
  const lines = intakeMarkdown.split(/\r?\n/);
  const answers: LaunchAnswer[] = [];
  let pendingQuestion: string | null = null;
  for (const line of lines) {
    const question = line.match(/^\d+\.\s+(.+)$/);
    if (question) { pendingQuestion = question[1].trim(); continue; }
    const answer = line.match(/^\s*ANSWER:\s*(.*)$/i);
    if (answer && pendingQuestion !== null) {
      answers.push({ question: pendingQuestion, answer: answer[1].trim() });
      pendingQuestion = null;
    }
  }
  return answers;
}

export function computeLaunchPhase(answered: number, dossierExists: boolean): LaunchPhase {
  if (dossierExists) return "complete";
  return answered >= MIN_ANSWERED_QUESTIONS ? "ready" : "intake-pending-answers";
}

export function renderDossierMarkdown(
  record: LaunchIntakeRecord,
  synthesis: LaunchSynthesis,
  raw: { gtm: string; audit: string; competition: string },
): string {
  return [
    `# Launch dossier: ${record.slug}`,
    "",
    `**Generated:** ${new Date().toISOString()}`,
    "**Status:** complete",
    "",
    "## Strategy & GTM",
    "",
    synthesis.strategy,
    "",
    "## Product audit status",
    "",
    synthesis.auditStatus,
    "",
    "## Competitive landscape & gaps",
    "",
    synthesis.competitiveGaps,
    "",
    "## Launch roadmap",
    "",
    synthesis.roadmap,
    "",
    "## Open risks",
    "",
    synthesis.openRisks,
    "",
    "## Appendix: raw specialist outputs",
    "",
    "### gtm-strategist",
    "",
    raw.gtm,
    "",
    "### product-auditor",
    "",
    raw.audit,
    "",
    "### competition-researcher",
    "",
    raw.competition,
    "",
  ].join("\n");
}
