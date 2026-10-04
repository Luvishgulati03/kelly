import type { ProviderEvent } from "../types.ts";
import { guardPublicReply, type GuardResult } from "./guard.ts";
import { classifyLimit, LIMIT_RESPONSE_MAX_CHARS } from "../providers/limits.ts";
import { isAuthFailureResponse } from "../providers/runner.ts";

/**
 * STREAMED PUBLIC REPLIES, GUARDED BY SENTENCE (ported from Henry's src/public/stream.ts).
 *
 * Model text arrives as small deltas (Claude --include-partial-messages) or as one whole message
 * (Codex). Nothing reaches a visitor until a whole sentence is buffered AND that sentence, and
 * everything sent so far plus that sentence, pass the output guard (src/public/guard.ts): checking
 * the cumulative text catches a secret or path that straddles a sentence break before its second
 * half is sent. The first sentence that fails stops the stream for good ("tripped"); the caller
 * then REPLACES what the visitor saw with the guarded full reply (the neutral refusal line). Text
 * that looks like a CLI notice rather than an answer (a usage-limit or logged-out message) only
 * pauses the stream ("held"): the finished run decides what the visitor gets.
 *
 * A provider attempt starting again discards what the earlier attempt streamed: a `reset` goes
 * out and the new attempt streams from scratch. A run that breaks the sandbox (halt) withdraws
 * everything and streams nothing more.
 */

export type StreamOutput = { type: "sentence"; text: string } | { type: "reset" };

export type StreamFinish =
  /** Everything streamed so far stands; `pieces` (possibly none) complete the reply. */
  | { action: "append"; pieces: string[] }
  /** What was streamed must be withdrawn and replaced by `text` (guarded full reply). */
  | { action: "replace"; text: string };

// A full stop after one of these is not a sentence end: initials, common abbreviations, and a
// list number at the start of a line ("1. "). A price ("₹500. GST is extra") still ends one.
const ABBREVIATION = /(?:(?:^|[\s(])(?:[A-Za-z]|e\.g|i\.e|etc|vs|approx|Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|Inc|Ltd|Co|No|Rs)|(?:^|\n)[ \t]*\d{1,2})\.$/i;

/**
 * Index just past the first complete sentence in `text` (its trailing whitespace included), or -1
 * while the sentence may still be growing. A boundary is `.`, `!`, `?`, `…` or the Hindi danda `।`
 * (plus closing quotes or brackets) followed by whitespace, or a newline. A decimal point
 * ("₹1,234.50") is never followed by whitespace, so it is never a boundary.
 */
export function sentenceEnd(text: string): number {
  const boundary = /[.!?…।]+["'”’)\]]*(?=\s)|\n/g;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text))) {
    const end = match.index + match[0].length;
    if (match[0] !== "\n" && match[0].endsWith(".") && ABBREVIATION.test(text.slice(0, end))) continue;
    let after = end;
    while (after < text.length && /\s/.test(text[after])) after += 1;
    return after;
  }
  return -1;
}

/** Splits already-final text into sentence pieces (the tail without a boundary is the last piece). */
export function sentencePieces(text: string): string[] {
  const pieces: string[] = [];
  let rest = text;
  for (;;) {
    const cut = sentenceEnd(rest);
    if (cut <= 0) break;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) pieces.push(rest);
  return pieces.filter((piece) => piece.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The visible-text part of one provider event for a public turn, or a "start" marker:
 *   start  Claude's system/init or Codex's thread.started (a provider attempt began);
 *   text   a Claude stream_event text_delta (token-level), or a Codex item.completed
 *          agent message (Codex's JSON stream carries no deltas).
 * Everything else (thinking, tool blocks, the final assistant/result echo, usage, stderr) is not
 * streamed: the final result is reconciled by PublicReplyStream.finish.
 */
export function publicStreamEvent(event: ProviderEvent): { kind: "start" } | { kind: "text"; text: string } | undefined {
  const parsed = event.parsed;
  if (event.stream !== "stdout" || !isRecord(parsed)) return undefined;
  if ((parsed.type === "system" && parsed.subtype === "init") || parsed.type === "thread.started") return { kind: "start" };
  if (parsed.type === "stream_event" && isRecord(parsed.event) && parsed.event.type === "content_block_delta") {
    const delta = parsed.event.delta;
    if (isRecord(delta) && delta.type === "text_delta" && typeof delta.text === "string" && delta.text) return { kind: "text", text: delta.text };
    return undefined;
  }
  if (parsed.type === "item.completed" && isRecord(parsed.item) && parsed.item.type === "agent_message" && typeof parsed.item.text === "string" && parsed.item.text.trim()) {
    return { kind: "text", text: parsed.item.text };
  }
  return undefined;
}

function looksLikeProviderNotice(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length >= LIMIT_RESPONSE_MAX_CHARS) return false;
  return classifyLimit(trimmed).limited || isAuthFailureResponse(trimmed);
}

export class PublicReplyStream {
  private buffer = "";
  private emitted = "";
  private state: "streaming" | "held" | "tripped" = "streaming";
  private halted = false;
  /** Why the guard stopped the stream (owner-side, content-free logging only). */
  tripReason?: string;
  /** Sentences sent to the visitor across the whole turn (resets included). */
  sentencesSent = 0;
  resets = 0;

  constructor(
    private readonly blockedValues: Array<string | undefined>,
    private readonly emit: (output: StreamOutput) => void,
  ) {}

  /** The text the visitor currently holds from this attempt. */
  get streamed(): string { return this.emitted; }
  get tripped(): boolean { return this.state === "tripped"; }

  /**
   * The run broke the public sandbox (a tool call or a loaded tool): withdraw what was streamed
   * and send nothing more for the rest of this turn, whatever follows.
   */
  halt(reason: string): void {
    if (this.halted) return;
    this.halted = true;
    this.tripReason = reason;
    if (this.emitted) { this.resets += 1; this.emit({ type: "reset" }); }
    this.buffer = "";
    this.emitted = "";
    this.state = "tripped";
  }

  /** A provider attempt began: drop anything an earlier attempt streamed. */
  start(): void {
    if (this.halted) return;
    if (this.emitted) { this.resets += 1; this.emit({ type: "reset" }); }
    this.buffer = "";
    this.emitted = "";
    this.state = "streaming";
    this.tripReason = undefined;
  }

  push(text: string): void {
    if (this.state !== "streaming" || !text) return;
    this.buffer += text;
    for (;;) {
      const cut = sentenceEnd(this.buffer);
      if (cut <= 0) return;
      const sentence = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut);
      if (!this.offer(sentence)) return;
    }
  }

  private offer(sentence: string): boolean {
    const candidate = this.emitted + sentence;
    if (!sentence.trim()) { this.emitted = candidate; return true; }
    // The sentence alone (anchored rules see it as a line of its own) and everything so far.
    const alone = guardPublicReply(sentence, this.blockedValues);
    const guard = alone.ok ? guardPublicReply(candidate, this.blockedValues) : alone;
    if (!guard.ok) { this.state = "tripped"; this.tripReason = guard.reason; return false; }
    if (looksLikeProviderNotice(candidate)) { this.state = "held"; return false; }
    this.emitted = candidate;
    this.sentencesSent += 1;
    this.emit({ type: "sentence", text: sentence });
    return true;
  }

  /**
   * Reconciles the stream with the run's final, fully guarded reply (the authority). When the
   * visitor's streamed text is a prefix of it, the rest is appended; otherwise (the guard tripped,
   * the stream was held on a notice, or the final message differs) it is replaced.
   */
  finish(final: GuardResult): StreamFinish {
    const sent = this.emitted.trimStart();
    if (!sent.trim()) return { action: "append", pieces: sentencePieces(final.text) };
    if (final.ok && this.state !== "tripped") {
      // The final text is trimmed; what streamed may end in whitespace the visitor already has.
      if (final.text.startsWith(sent)) return { action: "append", pieces: sentencePieces(final.text.slice(sent.length)) };
      const bare = sent.trimEnd();
      if (final.text.startsWith(bare)) return { action: "append", pieces: sentencePieces(final.text.slice(bare.length).trimStart()) };
    }
    return { action: "replace", text: final.text };
  }
}
