/** MASTER_PLAN.md §6.3 — launch crew. Phase of a launch directory (`data/launches/<slug>/`). */
export type LaunchPhase = "intake-pending-answers" | "ready" | "complete";

export interface LaunchQuestion {
  text: string;
  /** Which recalled playbook motivated the question ("[domain - module]"), or null. */
  citation: string | null;
}

/** The machine-readable half of intake — `intake.json`, regenerated verbatim by intake(), never hand-edited. */
export interface LaunchIntakeRecord {
  slug: string;
  createdAt: string;
  sourceKind: "repo" | "brief";
  /** Absolute path, present only when sourceKind === "repo". */
  sourcePath?: string;
  /** Luvish's raw input to `henry launch intake`. */
  input: string;
  productSummary: string;
  questions: LaunchQuestion[];
  /** Deduped citations across all questions, for the "Recalled playbooks" section. */
  citations: string[];
}

export interface LaunchIntakeResult {
  slug: string;
  filePath: string;
  recordPath: string;
  markdown: string;
  record: LaunchIntakeRecord;
}

/** One parsed Q/A pair from Luvish's hand-edited `intake.md`. */
export interface LaunchAnswer {
  question: string;
  answer: string;
}

export interface LaunchSynthesis {
  strategy: string;
  auditStatus: string;
  competitiveGaps: string;
  roadmap: string;
  openRisks: string;
}

export interface LaunchRunResult {
  slug: string;
  filePath: string;
  /** Short deterministic summary — also what gets written to memory. */
  summary: string;
  dossier: string;
}

export interface LaunchListItem {
  slug: string;
  phase: LaunchPhase;
  createdAt?: string;
  questionsTotal: number;
  questionsAnswered: number;
}
