export interface MeetingActionItem {
  owner: string;
  task: string;
  due?: string;
}

export interface MeetingPersonalNotes {
  /** Things Luvish committed to during the meeting. */
  commitments: string[];
  /** Luvish's existing projects this meeting affects. */
  affectsProjects: string[];
  /** Draft-worthy next steps for Luvish; drafting itself stays approval-gated. */
  suggestedFollowUps: string[];
}

export interface MeetingNotes {
  title: string;
  date: string;
  attendees: string[];
  decisions: string[];
  actionItems: MeetingActionItem[];
  openQuestions: string[];
  personalizedForDad: MeetingPersonalNotes;
}

export type Transcriber = (audioPath: string) => Promise<string>;

/** Renders markdown to a richer doc format (e.g. pandoc -> .docx). Returns false if unavailable/failed. */
export type DocRenderer = (markdownPath: string, outputPath: string) => Promise<boolean>;

export interface MeetingShadowResult {
  notes: MeetingNotes;
  markdownPath: string;
  /** The richest output produced: .docx if pandoc was available, otherwise a .txt copy. */
  outputPath: string;
  memoryIds: string[];
}
