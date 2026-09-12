/**
 * Hand-rolled ANSI primitives for Henry's terminal skin — ZERO npm dependencies
 * (no chalk/ink/blessed, per docs/tui-design.md).
 *
 * Everything here is additive: when color is off (`NO_COLOR`, a non-TTY stdout,
 * or `TERM=dumb`) every style function returns its input UNCHANGED, so piped
 * output stays byte-identical to plain text. `FORCE_COLOR=1` is the test seam
 * that lets snapshot tests see the escape codes without a real terminal.
 *
 * Style spans close with their SPECIFIC reset (`22`/`23`/`27`/`39`) rather than
 * a blanket `\x1b[0m`, so a styled span nested inside another does not wipe the
 * outer style on the way out.
 */

/** Where color support is read from. Both fields default to the live process. */
export interface ColorSource {
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
}

/** Narrowest width the renderer will ever wrap to (docs/tui-design.md §4). */
export const MIN_WIDTH = 40;

/**
 * Pure color-support decision. Precedence, highest first:
 *   1. `NO_COLOR` set to anything non-empty  → OFF (the no-color.org contract:
 *      the user asked for plain text, and nothing may override that).
 *   2. `FORCE_COLOR` set to anything but `0`/`false` → ON (the test seam).
 *   3. stdout is a TTY and `TERM` is not `dumb` → ON, else OFF.
 */
export function resolveColor(source: ColorSource = {}): boolean {
  const env = source.env ?? process.env;
  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor !== "") return false;
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== "" && force !== "0" && force !== "false") return true;
  const isTTY = source.isTTY ?? Boolean(process.stdout.isTTY);
  if (!isTTY) return false;
  return env.TERM !== "dumb";
}

let colorOn = resolveColor();

/** Current color state (every style helper consults this). */
export function isColor(): boolean {
  return colorOn;
}

/** Recomputes color support from the environment (or an explicit source) and returns it. */
export function refreshColor(source: ColorSource = {}): boolean {
  colorOn = resolveColor(source);
  return colorOn;
}

/** Test seam: force color on/off without touching the environment. */
export function setColorEnabled(on: boolean): void {
  colorOn = on;
}

/** Wraps `text` in an SGR span; a no-op when color is off. */
export function paint(text: string, open: string, close: string): string {
  if (!colorOn || text === "") return text;
  return `\x1b[${open}m${text}\x1b[${close}m`;
}

export const bold = (text: string): string => paint(text, "1", "22");
export const dim = (text: string): string => paint(text, "2", "22");
export const italic = (text: string): string => paint(text, "3", "23");
export const reverse = (text: string): string => paint(text, "7", "27");
export const cyan = (text: string): string => paint(text, "36", "39");
export const green = (text: string): string => paint(text, "32", "39");
export const red = (text: string): string => paint(text, "31", "39");
export const yellow = (text: string): string => paint(text, "33", "39");
/** Dim + reverse in one sequence — the inline-`code` span from the spec. */
export const reverseDim = (text: string): string => paint(text, "2;7", "27;22");

/** Accent colors: Henry is cyan, Bose (the mirrored module) is green. */
const ACCENTS = { cyan: "36", green: "32" } as const;
export type AccentName = keyof typeof ACCENTS;
let accentCode: string = ACCENTS.cyan;

/** Switches the accent used by `accent()` (Henry: cyan, Bose: green). */
export function setAccent(name: AccentName): void {
  accentCode = ACCENTS[name];
}

export const accent = (text: string): string => paint(text, accentCode, "39");
/** Accent + bold, emitted as one span so nothing nested can cancel half of it. */
export const accentBold = (text: string): string => paint(text, `1;${accentCode}`, "22;39");

const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Strips SGR/CSI escapes so widths can be measured on what the eye actually sees. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * Visible width in code points (escape sequences excluded). CJK/emoji double
 * width is explicitly out of scope for v1 (docs/tui-design.md §Module layout).
 */
export function visibleWidth(text: string): number {
  return [...stripAnsi(text)].length;
}

/** ANSI-aware `String.prototype.padEnd`. */
export function padEnd(text: string, width: number): string {
  const pad = width - visibleWidth(text);
  return pad > 0 ? text + " ".repeat(pad) : text;
}

/** ANSI-aware `String.prototype.padStart`. */
export function padStart(text: string, width: number): string {
  const pad = width - visibleWidth(text);
  return pad > 0 ? " ".repeat(pad) + text : text;
}

/** Cuts a styled string to `width` visible columns, ending with `…` when it had to cut. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  const plain = stripAnsi(text);
  const points = [...plain];
  if (points.length <= width) return text;
  return points.slice(0, Math.max(0, width - 1)).join("") + "…";
}

/** Wrap width for the current terminal: its columns, never below `MIN_WIDTH`. */
export function terminalWidth(columns?: number): number {
  const raw = columns ?? process.stdout.columns ?? 80;
  return Math.max(MIN_WIDTH, raw);
}

/**
 * Plain-text greedy word wrap. Words longer than `width` are hard-split so a
 * URL can never blow the right edge out. Always returns at least one line.
 */
export function wrapWords(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let piece = word;
    while ([...piece].length > limit) {
      if (current) { lines.push(current); current = ""; }
      const points = [...piece];
      lines.push(points.slice(0, limit).join(""));
      piece = points.slice(limit).join("");
    }
    if (!current) current = piece;
    else if ([...current].length + 1 + [...piece].length <= limit) current += ` ${piece}`;
    else { lines.push(current); current = piece; }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}
