/**
 * Re-review de-duplication — enforced in code, not by asking the model to remember.
 *
 * The prompt still carries "avoid duplicate findings" as a hint, but a model that is asked to
 * recall what it said three pushes ago fails often enough that an automated reviewer becomes
 * noise and gets switched off. So every finding is fingerprinted, compared against what Henry
 * actually posted on the PR (read back from GitHub, paginated), and dropped before the review is
 * ever staged for approval.
 *
 * ## Fingerprint scheme
 *
 * A finding's identity is `path + content signature`, and a *match* additionally requires
 * locality (`|Δline| <= LINE_DRIFT`). Splitting it this way is deliberate:
 *
 * - The **content signature** is a normalised token set of `title + body`: code fences and URLs
 *   dropped, `camelCase`/`snake_case` split into words, line references (`line 42`, `:42`) and
 *   bare integers removed (they shift on every push), lowercased, punctuation stripped,
 *   stopwords and reviewer filler removed, de-duplicated and sorted. Two rewordings of the same
 *   finding keep almost the same content words ("missing null check on `user`" vs "`user` may be
 *   null here — this will throw"), so they land on the same or a very similar token set.
 * - `fingerprint()` hashes that set: identical or trivially-reworded findings hash equal, which
 *   is the cheap exact path. Because the hash contains no line number, it survives line drift.
 * - Rewording that changes more words is caught by a **Dice coefficient** over the two token sets
 *   (`>= SIMILARITY_THRESHOLD`, and at least `MIN_SHARED_TOKENS` shared tokens so a one-word
 *   coincidence between two short findings cannot match). This is what keeps two genuinely
 *   different findings on the same line apart: "missing null guard on user" and "N+1 query in
 *   this loop" share no content tokens at all, so their similarity is 0 and both survive.
 * - The **line** is only a locality gate, never part of the hash, so a push that moves code a few
 *   lines does not resurrect every finding. `LINE_DRIFT` is wide enough for ordinary drift and
 *   narrow enough that the same issue in two different parts of one file stays two findings.
 *
 * ## Changed lines are never suppressed
 *
 * New code deserves a fresh look even when it looks like old code. For every distinct commit that
 * Henry previously reviewed, we ask GitHub to compare that commit to the current head and record
 * which lines on the new side were added/modified. A finding sitting on (or within
 * `CHANGE_CONTEXT` lines of) such a line is kept even when its fingerprint matches — the reason
 * is recorded so the run can say why.
 *
 * If a compare cannot be fetched, that commit is unknown and the matching finding is kept. A
 * missing change check must not turn changed code into a silently suppressed finding.
 *
 * ## Severity escalation is never suppressed
 *
 * If Henry previously posted the same finding as a `nit` and now calls it a `blocker`, that is new
 * information for the human, so it is kept.
 *
 * Nothing here posts to GitHub. Every call is a read.
 */

import { createHash } from "node:crypto";
import type { ReviewFinding } from "../types.ts";

/** Lines a finding may drift by and still count as the same location. */
export const LINE_DRIFT = 25;
/** How close a finding must be to a changed line to count as sitting on new code. */
export const CHANGE_CONTEXT = 2;
/** Dice coefficient above which two token sets are treated as the same finding. */
export const SIMILARITY_THRESHOLD = 0.6;
/** Distinct content tokens two findings must share before similarity is even considered. */
export const MIN_SHARED_TOKENS = 2;
/** Page size and page cap for every paginated GitHub read. */
const PER_PAGE = 100;
const MAX_PAGES = 20;
/** Cap on compare calls: one per distinct previously-reviewed commit. */
const MAX_COMPARE_COMMITS = 10;

const SEVERITY_RANK: Record<ReviewFinding["severity"], number> = { nit: 0, warning: 1, blocker: 2 };

const STOPWORDS = new Set([
  "the", "this", "that", "these", "those", "a", "an", "and", "or", "but", "if", "then", "than", "so", "as", "at",
  "by", "for", "from", "in", "into", "of", "on", "to", "with", "within", "without", "is", "are", "was", "were",
  "be", "been", "being", "it", "its", "they", "them", "we", "you", "your", "our", "here", "there", "when", "where",
  "which", "who", "what", "how", "why", "not", "no", "nor", "do", "does", "did", "done", "can", "could", "may",
  "might", "must", "should", "would", "will", "shall", "have", "has", "had", "get", "gets", "make", "makes",
  "use", "uses", "used", "using", "also", "just", "only", "very", "more", "most", "any", "all", "each", "every",
  "some", "such", "same", "other", "either", "both", "because", "since", "while", "after", "before", "over",
  "under", "up", "down", "out", "off", "again", "once", "now", "code", "line", "lines", "file", "please",
  "consider", "instead", "currently", "seems", "looks", "like", "note", "issue", "problem", "suggest",
  "suggestion", "review", "change", "changes", "above", "below",
]);

/** A finding Henry already posted on this PR, read back from GitHub. */
export interface PriorFinding {
  path: string;
  line: number;
  /** Severity Henry gave it, when the posted body still carries Henry's format. */
  severity?: ReviewFinding["severity"];
  fingerprint: string;
  tokens: string[];
  /** Commit the comment was made against — the base for "did this line change since?". */
  commitId?: string;
  source: "inline" | "top-level";
}

export interface SuppressedFinding {
  path: string;
  line: number;
  title: string;
  severity: ReviewFinding["severity"];
  fingerprint: string;
  /** Fingerprint of the already-posted comment this matched. */
  matched: string;
  reason: "identical" | "reworded";
}

export interface DedupeResult {
  kept: ReviewFinding[];
  suppressed: SuppressedFinding[];
}

/** Lines that changed on the new side, per previously-reviewed commit, per path. */
export interface ChangedLineIndex {
  known: boolean;
  bySha: Map<string, Map<string, Set<number>>>;
}

export interface CommandLike {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type CommandExecutor = (command: string, args: string[], cwd: string, input?: string) => Promise<CommandLike>;

/**
 * Invisible on GitHub, exact for us: every inline comment Henry posts carries the fingerprint of
 * the finding that produced it, so the next run recognises its own work without re-deriving it
 * from prose. Comments posted before this existed still match through the text signature below.
 */
const MARKER_PREFIX = "<!-- henry-review v1";
const MARKER_RE = /<!--\s*henry-review v1\s+fp=([a-f0-9]+)(?:\s+path=(\S+))?(?:\s+line=(\d+))?\s*-->/;

export function renderFindingMarker(finding: ReviewFinding): string {
  return `${MARKER_PREFIX} fp=${fingerprintFinding(finding)} path=${finding.path} line=${finding.line} -->`;
}

export function normalizePath(value: string): string {
  return value.trim().replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Content words of a finding, stable under rewording, line drift and formatting noise. */
export function normalizeTokens(text: string): string[] {
  const tokens = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b(?:lines?|ln|col|column)\s*[:#]?\s*\d+(?:\s*[-–]\s*\d+)?/gi, " ")
    .replace(/:\d+(?::\d+)?\b/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length > 1 && !/^\d+$/.test(token) && !STOPWORDS.has(token));
  return [...new Set(tokens)].sort();
}

export function signatureOf(text: string): string {
  return normalizeTokens(text).join(" ");
}

/** Stable identity of a finding: path plus content signature. Deliberately excludes the line. */
export function fingerprint(path: string, text: string): string {
  return createHash("sha256").update(`henry-review-v1|${normalizePath(path)}|${signatureOf(text)}`).digest("hex").slice(0, 16);
}

export function fingerprintFinding(finding: Pick<ReviewFinding, "path" | "title" | "body">): string {
  return fingerprint(finding.path, `${finding.title} ${finding.body}`);
}

/** Dice coefficient over two sorted, de-duplicated token sets. */
export function similarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const other = new Set(b);
  const shared = a.filter((token) => other.has(token)).length;
  return (2 * shared) / (a.length + b.length);
}

function sharedCount(a: string[], b: string[]): number {
  const other = new Set(b);
  return a.filter((token) => other.has(token)).length;
}

interface RawComment {
  body?: unknown;
  path?: unknown;
  line?: unknown;
  original_line?: unknown;
  commit_id?: unknown;
  original_commit_id?: unknown;
  user?: { login?: unknown } | null;
}

function severityFrom(value: string): ReviewFinding["severity"] | undefined {
  return value === "blocker" || value === "warning" || value === "nit" ? value : undefined;
}

/** Henry's own inline comment format: `**severity — title**\n\nbody` plus an optional marker. */
export function parseHenryBody(body: string): { severity?: ReviewFinding["severity"]; text: string; fingerprint?: string; path?: string; line?: number } {
  const marker = body.match(MARKER_RE);
  const withoutMarker = body.replace(MARKER_RE, " ").trim();
  const header = withoutMarker.match(/^\*\*\s*(blocker|warning|nit)\s*[—–-]\s*([\s\S]*?)\*\*/i);
  const text = header ? `${header[2]} ${withoutMarker.slice(header[0].length)}` : withoutMarker;
  return {
    severity: header ? severityFrom(header[1].toLowerCase()) : undefined,
    text,
    fingerprint: marker?.[1],
    path: marker?.[2],
    line: marker?.[3] ? Number(marker[3]) : undefined,
  };
}

/**
 * Henry authored a comment when it carries Henry's marker, when the account matches the
 * configured GitHub login, or when the body still uses Henry's `**severity — title**` format
 * (comments posted before markers existed). Anybody else's comments are left alone: a human's
 * remark must never silently swallow a finding.
 */
export function isHenryAuthored(comment: RawComment, login?: string): boolean {
  const body = typeof comment.body === "string" ? comment.body : "";
  const author = typeof comment.user?.login === "string" ? comment.user.login : "";
  if (MARKER_RE.test(body)) {
    return !login || !author || author.toLowerCase() === login.toLowerCase();
  }
  if (login && author && author.toLowerCase() === login.toLowerCase()) return true;
  // Once the configured account is known, a severity-shaped body from somebody else is
  // still somebody else's comment. The format fallback is only for old deployments that
  // cannot identify Henry's GitHub login yet.
  if (login) return false;
  return /^\*\*\s*(blocker|warning|nit)\s*[—–-]/i.test(body.trim());
}

export function priorFromComment(comment: RawComment, source: PriorFinding["source"], login?: string): PriorFinding | undefined {
  if (!isHenryAuthored(comment, login)) return undefined;
  const body = typeof comment.body === "string" ? comment.body : "";
  const parsed = parseHenryBody(body);
  const rawPath = typeof comment.path === "string" ? comment.path : parsed.path;
  const rawLine = Number(comment.line ?? comment.original_line ?? parsed.line);
  if (!rawPath || !Number.isFinite(rawLine) || rawLine < 1) return undefined;
  const path = normalizePath(rawPath);
  const tokens = normalizeTokens(parsed.text);
  const commitId = typeof comment.commit_id === "string" ? comment.commit_id
    : typeof comment.original_commit_id === "string" ? comment.original_commit_id : undefined;
  return {
    path,
    line: Math.floor(rawLine),
    severity: parsed.severity,
    fingerprint: parsed.fingerprint || fingerprint(path, parsed.text),
    tokens,
    commitId,
    source,
  };
}

/** New-side line numbers touched by a unified-diff patch (added or modified lines). */
export function changedLinesFromPatch(patch: string): Set<number> {
  const changed = new Set<number>();
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { newLine = Number(hunk[1]); continue; }
    if (!newLine) continue;
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) { changed.add(newLine); newLine += 1; continue; }
    if (raw.startsWith("-")) continue;
    if (raw.startsWith("\\")) continue;
    newLine += 1;
  }
  return changed;
}

export function emptyChangedLineIndex(known = false): ChangedLineIndex {
  return { known, bySha: new Map() };
}

/** True when the finding sits on, or beside, code that changed since the commit Henry reviewed. */
export function lineChangedSince(index: ChangedLineIndex, sha: string | undefined, path: string, line: number): boolean {
  // Without the comment's base commit, an exact legacy duplicate is still safe to match. With a
  // commit, however, an unknown comparison must be treated conservatively: the line may have
  // changed, so do not suppress it.
  if (!sha) return false;
  if (!index.known || !index.bySha.has(sha)) return true;
  const byPath = index.bySha.get(sha);
  const lines = byPath?.get(normalizePath(path));
  if (!lines) return false;
  for (let offset = -CHANGE_CONTEXT; offset <= CHANGE_CONTEXT; offset += 1) if (lines.has(line + offset)) return true;
  return false;
}

/**
 * Drop findings Henry already posted. A finding is suppressed only when all of these hold:
 * same file, within `LINE_DRIFT` lines, same-or-similar content signature, the line has not
 * changed since that comment's commit, and the severity has not been escalated.
 */
export function dedupeFindings(findings: ReviewFinding[], priors: PriorFinding[], changed: ChangedLineIndex = emptyChangedLineIndex(true)): DedupeResult {
  const kept: ReviewFinding[] = [];
  const suppressed: SuppressedFinding[] = [];
  for (const finding of findings) {
    const path = normalizePath(finding.path);
    const tokens = normalizeTokens(`${finding.title} ${finding.body}`);
    const own = fingerprintFinding(finding);
    let match: { prior: PriorFinding; reason: SuppressedFinding["reason"] } | undefined;
    for (const prior of priors) {
      if (prior.path !== path) continue;
      if (Math.abs(prior.line - finding.line) > LINE_DRIFT) continue;
      const identical = prior.fingerprint === own;
      const reworded = !identical
        && sharedCount(tokens, prior.tokens) >= MIN_SHARED_TOKENS
        && similarity(tokens, prior.tokens) >= SIMILARITY_THRESHOLD;
      if (!identical && !reworded) continue;
      // New code deserves a fresh look even when it reads like the old code.
      if (lineChangedSince(changed, prior.commitId, path, finding.line)) continue;
      // An escalation ("nit" last time, "blocker" now) is new information for the human.
      if (prior.severity && SEVERITY_RANK[finding.severity] > SEVERITY_RANK[prior.severity]) continue;
      match = { prior, reason: identical ? "identical" : "reworded" };
      break;
    }
    if (!match) { kept.push(finding); continue; }
    suppressed.push({ path: finding.path, line: finding.line, title: finding.title, severity: finding.severity, fingerprint: own, matched: match.prior.fingerprint, reason: match.reason });
  }
  return { kept, suppressed };
}

function parseArray(value: string): RawComment[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; }
  catch { throw new Error("Expected JSON array from GitHub comments endpoint"); }
  if (!Array.isArray(parsed)) throw new Error("Expected JSON array from GitHub comments endpoint");
  return parsed as RawComment[];
}

/**
 * Read every page of a GitHub list endpoint through the same `gh` CLI the rest of this module
 * uses. Explicit `page=` walking rather than `gh api --paginate`, because older `gh` builds
 * concatenate pages into invalid JSON and this has to stay parseable.
 */
async function ghPages(exec: CommandExecutor, cwd: string, endpoint: string): Promise<RawComment[]> {
  const all: RawComment[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const result = await exec("gh", ["api", `${endpoint}${separator}per_page=${PER_PAGE}&page=${page}`], cwd);
    if (result.exitCode !== 0) throw new Error(result.stderr || `gh api ${endpoint} failed`);
    const items = parseArray(result.stdout);
    all.push(...items);
    if (items.length < PER_PAGE) break;
    if (page === MAX_PAGES) throw new Error(`GitHub comments pagination exceeded ${MAX_PAGES} pages`);
  }
  return all;
}

/** Every finding Henry has already posted on this PR: inline review comments plus top-level ones. */
export async function fetchPriorFindings(exec: CommandExecutor, cwd: string, repository: string, pullRequest: number, login?: string): Promise<PriorFinding[]> {
  const inline = await ghPages(exec, cwd, `repos/${repository}/pulls/${pullRequest}/comments`);
  const topLevel = await ghPages(exec, cwd, `repos/${repository}/issues/${pullRequest}/comments`);
  const priors: PriorFinding[] = [];
  for (const comment of inline) {
    const prior = priorFromComment(comment, "inline", login);
    if (prior) priors.push(prior);
  }
  for (const comment of topLevel) {
    const prior = priorFromComment(comment, "top-level", login);
    if (prior) priors.push(prior);
  }
  return priors;
}

interface CompareFile { filename?: unknown; patch?: unknown }

/** Lines changed on the new side between a previously-reviewed commit and the current head. */
export async function fetchChangedLines(exec: CommandExecutor, cwd: string, repository: string, baseSha: string, headSha: string): Promise<Map<string, Set<number>>> {
  const byPath = new Map<string, Set<number>>();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await exec("gh", ["api", `repos/${repository}/compare/${baseSha}...${headSha}?per_page=${PER_PAGE}&page=${page}`], cwd);
    if (result.exitCode !== 0) throw new Error(result.stderr || "gh api compare failed");
    let files: CompareFile[];
    try {
      const parsed = JSON.parse(result.stdout) as { files?: unknown };
      if (!Array.isArray(parsed.files)) throw new Error("missing files");
      files = parsed.files as CompareFile[];
    } catch { throw new Error("Expected compare response with a files array"); }
    for (const file of files) {
      if (typeof file.filename !== "string" || typeof file.patch !== "string") continue;
      const path = normalizePath(file.filename);
      const lines = byPath.get(path) || new Set<number>();
      for (const line of changedLinesFromPatch(file.patch)) lines.add(line);
      byPath.set(path, lines);
    }
    if (files.length < PER_PAGE) break;
    if (page === MAX_PAGES) throw new Error(`GitHub compare pagination exceeded ${MAX_PAGES} pages`);
  }
  return byPath;
}

/** One compare per distinct commit Henry previously reviewed, so drift is judged per comment. */
export async function buildChangedLineIndex(exec: CommandExecutor, cwd: string, repository: string, priors: PriorFinding[], headSha: string | undefined): Promise<ChangedLineIndex> {
  const index = emptyChangedLineIndex(false);
  if (!headSha || !repository || repository === "unknown/unknown") return index;
  const shas = [...new Set(priors.map((prior) => prior.commitId).filter((sha): sha is string => Boolean(sha) && sha !== headSha))].slice(0, MAX_COMPARE_COMMITS);
  if (!shas.length) return { known: true, bySha: index.bySha };
  let anyKnown = false;
  for (const sha of shas) {
    try {
      index.bySha.set(sha, await fetchChangedLines(exec, cwd, repository, sha, headSha));
      anyKnown = true;
    } catch { /* one unreachable compare must not fail the review; its findings stay unsuppressed. */ }
  }
  index.known = anyKnown;
  return index;
}
