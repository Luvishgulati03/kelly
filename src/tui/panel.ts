/**
 * Boxes, tables, glyphs, banner, spinner and prompt (docs/tui-design.md §1/§2/§3/§5/§6/§7).
 *
 * Everything here is a PURE function: string(s) in, string out, no I/O — so the
 * REPL stays the only place that touches stdout, and every visual is testable.
 *
 * Degradation rules, in one place so they can't drift:
 *   - banner  → collapses to ONE plain line when color is off.
 *   - spinner → falls back to the REPL's original `henry is thinking… Ns` text.
 *   - prompt  → falls back to the REPL's original `henry> `.
 *   - panels/glyphs keep their (colorless) box-drawing and glyphs: those are
 *     layout, not color, and NO_COLOR is a statement about color.
 */
import {
  accent, accentBold, dim, green, isColor, padEnd, padStart, red, terminalWidth, truncate,
  visibleWidth, wrapWords, yellow,
} from "./ansi.ts";

/* ────────────────────────────── glyphs ────────────────────────────── */

export type Severity = "ok" | "err" | "warn" | "info";

export const GLYPHS: Record<Severity, string> = { ok: "✓", err: "✗", warn: "⚠", info: "◆" };

const GLYPH_PAINT: Record<Severity, (text: string) => string> = {
  ok: green, err: red, warn: yellow, info: accent,
};

/** `✓ dashboard up` — the one way REPL messages announce themselves. */
export function note(kind: Severity, text: string): string {
  return `${GLYPH_PAINT[kind](GLYPHS[kind])} ${text}`;
}

/* ────────────────────────────── panels ────────────────────────────── */

export interface KeyValueRow {
  key: string;
  value: string | number;
}

export interface HeadingRow {
  heading: string;
}

/** A plain string is a free-text line; `""` is a blank line inside the box. */
export type PanelRow = string | KeyValueRow | HeadingRow;

export interface PanelOptions {
  /** Hard ceiling for the box (defaults to the terminal width, min 40). */
  width?: number;
  /** Style command-style keys with the accent instead of dim. */
  accentKeys?: boolean;
}

const NUMERIC = /^-?\d[\d,]*(?:\.\d+)?%?$/;

const isKeyValue = (row: PanelRow): row is KeyValueRow => typeof row === "object" && "key" in row;
const isHeading = (row: PanelRow): row is HeadingRow => typeof row === "object" && "heading" in row;

/**
 * A rounded box with a title tab and a dim border. Key/value rows lay out in two
 * columns; values that are numbers are right-aligned in their column and values
 * too long for the box wrap under the value column instead of blowing the edge.
 * The box hugs its content and never exceeds `width`.
 */
export function panel(title: string, body: string | PanelRow[], options: PanelOptions = {}): string {
  const maxWidth = Math.max(20, options.width ?? terminalWidth());
  const maxInner = maxWidth - 4;
  const rows: PanelRow[] = typeof body === "string"
    ? body.split("\n").flatMap((line) => (line.trim() ? wrapWords(line, maxInner) : [""]))
    : body;

  const keyWidth = Math.min(
    Math.max(0, ...rows.filter(isKeyValue).map((row) => visibleWidth(row.key))),
    Math.max(4, Math.floor(maxInner / 2)),
  );
  const valueBudget = Math.max(4, maxInner - keyWidth - 2);
  const valueWidth = Math.min(
    valueBudget,
    Math.max(0, ...rows.filter(isKeyValue).flatMap((row) => String(row.value).split("\n").map(visibleWidth))),
  );
  // Numbers right-align against each other at the START of the value column —
  // pinning them to the far right edge of a column sized by some unrelated URL
  // reads as a gap, not a column.
  const numberWidth = Math.max(
    0,
    ...rows.filter(isKeyValue).map((row) => {
      const value = String(row.value);
      return NUMERIC.test(value.trim()) ? visibleWidth(value) : 0;
    }),
  );
  const plainWidth = Math.max(
    0,
    ...rows.map((row) => (typeof row === "string" ? visibleWidth(row) : isHeading(row) ? visibleWidth(row.heading) : 0)),
  );
  const inner = Math.min(
    maxInner,
    Math.max(
      keyWidth ? keyWidth + 2 + valueWidth : 0,
      plainWidth,
      visibleWidth(title) ? visibleWidth(title) + 2 : 0,
    ),
  );

  const boxWidth = inner + 4;
  const lines: string[] = [];
  const top = visibleWidth(title)
    ? `${dim("╭─")} ${accentBold(title)} ${dim(`${"─".repeat(Math.max(0, boxWidth - 5 - visibleWidth(title)))}╮`)}`
    : dim(`╭${"─".repeat(boxWidth - 2)}╮`);
  lines.push(top);

  const push = (content: string): void => {
    lines.push(`${dim("│")} ${padEnd(content, inner)} ${dim("│")}`);
  };

  for (const row of rows) {
    if (typeof row === "string") {
      push(truncate(row, inner));
      continue;
    }
    if (isHeading(row)) {
      push(dim(truncate(row.heading, inner)));
      continue;
    }
    const key = truncate(row.key, keyWidth);
    const paintedKey = options.accentKeys ? accent(key) : dim(key);
    const rawValues = String(row.value).split("\n");
    const pieces = rawValues.flatMap((value) => (visibleWidth(value) > valueWidth ? wrapWords(value, valueWidth) : [value]));
    pieces.forEach((piece, index) => {
      const cell = pieces.length === 1 && NUMERIC.test(piece.trim())
        ? padStart(piece, numberWidth)
        : piece;
      const prefix = index === 0 ? padEnd(paintedKey, keyWidth) : " ".repeat(keyWidth);
      push(`${prefix}  ${cell}`);
    });
  }

  lines.push(dim(`╰${"─".repeat(boxWidth - 2)}╯`));
  return lines.join("\n");
}

/* ─────────────────────────────── :help ─────────────────────────────── */

export interface CommandSpec {
  /** The literal command, e.g. `:provider`. */
  name: string;
  /** Argument sketch shown after the name, e.g. `<query>`. */
  args?: string;
  summary: string;
  group?: string;
}

/**
 * Renders the declarative command table into a panel — the whole point being
 * that help is GENERATED from the table the REPL dispatches on, so it cannot
 * drift from what the REPL actually does.
 */
export function commandPanel(title: string, commands: CommandSpec[], options: PanelOptions = {}): string {
  const groups: string[] = [];
  for (const command of commands) {
    const group = command.group ?? "";
    if (!groups.includes(group)) groups.push(group);
  }
  const rows: PanelRow[] = [];
  for (const group of groups) {
    if (rows.length) rows.push("");
    if (group) rows.push({ heading: group });
    for (const command of commands.filter((item) => (item.group ?? "") === group)) {
      rows.push({ key: command.args ? `${command.name} ${command.args}` : command.name, value: command.summary });
    }
  }
  return panel(title, rows, { ...options, accentKeys: true });
}

/* ────────────────────────────── banner ────────────────────────────── */

/** 3-line HENRY wordmark (box-drawing "small caps"), 15 columns wide. */
export const HENRY_MARK = [
  "╻ ╻┏━╸┏┓╻┏━┓╻ ╻",
  "┣━┫┣╸ ┃┗┫┣┳┛┗┳┛",
  "╹ ╹┗━╸╹ ╹╹┗╸ ╹ ",
];

export interface BannerOptions {
  /** Plain-mode name and the fallback line's prefix. */
  name?: string;
  mark?: string[];
  /** Status segments, joined with ` · ` — provider, dashboard URL, telegram state… */
  status: string[];
  width?: number;
}

/**
 * Boot banner: wordmark + one dim status line + a blank line = 5 lines, leaving
 * the prompt as line 6 (the spec's ≤6 budget). With color off it collapses to a
 * single plain line so piped/`NO_COLOR` Henry stays quiet.
 */
export function banner(options: BannerOptions): string {
  const name = options.name ?? "HENRY";
  const width = options.width ?? terminalWidth();
  const status = options.status.filter(Boolean).join(" · ");
  if (!isColor()) return truncate(`${name} · ${status}`, width);
  const mark = (options.mark ?? HENRY_MARK).map((line) => dim(accent(line)));
  return [...mark, dim(truncate(status, width)), ""].join("\n");
}

/* ───────────────────────── spinner + prompt ───────────────────────── */

/** Braille cycle from the spec. */
export const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];

/** Columns the REPL blanks when it erases the spinner (unchanged from pre-TUI Henry). */
export const SPINNER_CLEAR_WIDTH = 28;

/** `\r`, blanks, `\r` — erases the spinner in place without touching scrollback. */
export function clearLine(width: number = SPINNER_CLEAR_WIDTH): string {
  return `\r${" ".repeat(Math.max(0, width))}\r`;
}

/** First paint of the spinner (no elapsed time yet). Plain form is the pre-TUI string. */
export function spinnerStart(label = "thinking"): string {
  return isColor() ? dim(`${SPINNER_FRAMES[0]} ${label}…`) : `henry is ${label}… `;
}

/** One spinner tick. Plain form is byte-for-byte the pre-TUI `henry is thinking… Ns `. */
export function spinnerTick(tick: number, seconds: number, label = "thinking"): string {
  if (!isColor()) return `henry is ${label}… ${seconds}s `;
  const frame = SPINNER_FRAMES[((tick % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length];
  return dim(`${frame} ${label}… ${seconds}s`);
}

export interface PromptOptions {
  name?: string;
  /** True while a turn is queued behind a running one — renders `… ❯ `. */
  queued?: boolean;
}

/** `henry ❯ ` / `… ❯ ` with color; the original `henry> ` without. */
export function prompt(options: PromptOptions = {}): string {
  const name = options.name ?? "henry";
  if (!isColor()) return `${name}> `;
  return `${dim(options.queued ? "…" : name)} ${accent("❯")} `;
}
