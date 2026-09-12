export type JobSource = "linkedin" | "twitter" | "generic";

export type ApplicationStatus =
  | "discovered"
  | "drafted"
  | "ready-for-review"
  | "filled"
  /** Persisted before browser submission starts; blocks retries unless a proven pre-click fill failure restores the prior state. */
  | "submitting"
  | "submitted"
  /**
   * Browser submission started and no confirmed safe pre-click outcome was observed. The
   * application may or may not have reached the employer, so this is deliberately NOT
   * `failed`: a retry could submit a second time. Terminal until a human resolves it.
   */
  | "submission-uncertain"
  | "rejected"
  | "failed";

export interface JobQuestion {
  id: string;
  label: string;
  required: boolean;
  kind: "text" | "textarea" | "boolean" | "single" | "multi";
  options?: string[];
}

export interface JobPosting {
  id: string;
  url: string;
  source: JobSource;
  title: string;
  company: string;
  description: string;
  descriptionHash: string;
  questions: JobQuestion[];
  discoveredAt: string;
}

export interface JobApplicationDraft {
  id: string;
  posting: JobPosting;
  coverLetter: string;
  answers: Record<string, string>;
  rationale: Record<string, string>;
  missingFacts: string[];
  memoryIds: string[];
  resumeMarkdownPath?: string;
  resumePdfPath?: string;
  status: ApplicationStatus;
  createdAt: string;
  updatedAt: string;
  approvalId?: string;
  submittedAt?: string;
  submissionUrl?: string;
  error?: string;
  /** Independent review is advisory; it never constitutes outbound approval. */
  review?: { accepted: boolean; issues: string[]; sourceHash: string; draftHash: string };
  reviewedContentHash?: string;
  resumeSha256?: string;
  resumeEditsPath?: string;
}

export interface JobApplicationSummary {
  total: number;
  discovered: number;
  drafted: number;
  readyForReview: number;
  filled: number;
  submitting: number;
  submitted: number;
  rejected: number;
  failed: number;
}

export interface JobPageSnapshot {
  url: string;
  title: string;
  company: string;
  description: string;
  questions: JobQuestion[];
  capturedAt: string;
}
