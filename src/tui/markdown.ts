/**
 * The markdown-lite streaming renderer (docs/tui-design.md §4).
 *
 * Two contracts hold this file together:
 *
 *  1. PURITY — `renderMarkdown(text)` is a pure function (string in, ANSI string
 *     out) so every visual is snapshot-testable with no terminal involved.
 *  2. CHUNK SAFETY — provider text arrives in arbitrary pieces (a JSONL event can
 *     end mid-word, mid-`**`, or between the two halves of a fence). The renderer
 *     buffers by LINE and never by more: a chunk that completes no line emits
 *     nothing, a chunk that completes three lines emits three, and block state
 *     (an open fence and its language tag) survives across chunks. Feeding a
 *     document in N chunks always produces the same bytes as feeding it in one.
 *
 * When color is off (NO_COLOR / non-TTY) the renderer is the IDENTITY function:
 * bytes in, same bytes out, no buffering, no rewrapping. Piped Henry looks
 * exactly like it did before the TUI existed.
 */
import {
  MIN_WIDTH, accent, accentBold, bold, dim, isColor, italic, terminalWidth, visibleWidth,
} from "./ansi.ts";

export interface MarkdownOptions {
  /** Wrap width; defaults to the terminal's, and is never allowed below `MIN_WIDTH`. */
  width?: number;
}

export interface StreamRenderer {
  /** Feeds one chunk; returns the styled text that is ready to print (may be ""). */
  write(chunk: string): string;
  /** Renders whatever partial line is still held and clears block state. */
  flush(): string;
}

/** One inline run of text plus the SGR codes that style it. */
interface Span {
  text: string;
  open: string;
  close: string;
}

interface Token extends Span {
  space: boolean;
}

const CODE_OPEN = "2;7";
const CODE_CLOSE = "27;22";
const BOLD_OPEN = "1";
const BOLD_CLOSE = "22";

const FENCE = /^\s*(?:`{3,}|~{3,})\s*(\S*)/;
const HEADER = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+[.)])\s+(.*)$/;
const QUOTE = /^(\s*)>\s?(.*)$/;

/**
 * Splits a line into styled runs: `` `code` `` → reverse-dim, `**bold**` → bold.
 * Unclosed markers stay literal — safe because a line is only ever rendered once
 * it is COMPLETE, so a `**` split across two chunks is still one line here.
 * Styles are deliberately not nested: a code span inside bold keeps its
 * backticks, which beats emitting a reset that would cancel the outer bold.
 */
function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain) spans.push({ text: plain, open: "", close: "" });
    plain = "";
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "`") {
      const end = text.indexOf("`", index + 1);
      if (end > index + 1) {
        flush();
        spans.push({ text: text.slice(index + 1, end), open: CODE_OPEN, close: CODE_CLOSE });
        index = end + 1;
        continue;
      }
    } else if (char === "*" && text[index + 1] === "*") {
      const end = text.indexOf("**", index + 2);
      if (end > index + 2) {
        flush();
        spans.push({ text: text.slice(index + 2, end), open: BOLD_OPEN, close: BOLD_CLOSE });
        index = end + 2;
        continue;
      }
    }
    plain += char;
    index += 1;
  }
  flush();
  return spans;
}

/** Explodes spans into words and spaces; a space keeps the style of the span it came from. */
function tokenize(spans: Span[]): Token[] {
  const tokens: Token[] = [];
  for (const span of spans) {
    for (const piece of span.text.split(/(\s+)/)) {
      if (!piece) continue;
      tokens.push({ text: piece, open: span.open, close: span.close, space: /^\s+$/.test(piece) });
    }
  }
  return tokens;
}

/** Paints one wrapped line, merging neighbouring runs that share a style. */
function renderTokens(tokens: Token[]): string {
  let out = "";
  let runText = "";
  let runOpen = "";
  let runClose = "";
  const flushRun = (): void => {
    if (!runText) return;
    out += runOpen && isColor() ? `\x1b[${runOpen}m${runText}\x1b[${runClose}m` : runText;
    runText = "";
  };
  for (const token of tokens) {
    if (token.open !== runOpen || token.close !== runClose) {
      flushRun();
      runOpen = token.open;
      runClose = token.close;
    }
    runText += token.text;
  }
  flushRun();
  return out;
}

/**
 * Greedy wrap over styled tokens, measured in VISIBLE columns so escape codes
 * never eat the budget. A style that spans a wrap is re-opened on the next line
 * (terminals require that). Words longer than the budget are hard-split, so a
 * pasted URL can't blow out the right edge.
 */
function wrapRuns(tokens: Token[], available: number): string[] {
  const limit = Math.max(4, available);
  const lines: Token[][] = [];
  let current: Token[] = [];
  let currentWidth = 0;
  let pending: Token[] = [];
  let pendingWidth = 0;

  const breakLine = (): void => {
    lines.push(current);
    current = [];
    currentWidth = 0;
    pending = [];
    pendingWidth = 0;
  };

  for (const token of tokens) {
    if (token.space) {
      if (current.length) {
        pending.push(token);
        pendingWidth += [...token.text].length;
      }
      continue;
    }
    let word = token;
    let wordWidth = [...word.text].length;
    if (current.length && currentWidth + pendingWidth + wordWidth > limit) breakLine();
    while (wordWidth > limit) {
      if (current.length) breakLine();
      const points = [...word.text];
      lines.push([{ ...word, text: points.slice(0, limit).join("") }]);
      word = { ...word, text: points.slice(limit).join("") };
      wordWidth = [...word.text].length;
    }
    if (current.length && currentWidth + pendingWidth + wordWidth > limit) breakLine();
    if (pending.length) {
      current.push(...pending);
      currentWidth += pendingWidth;
      pending = [];
      pendingWidth = 0;
    }
    current.push(word);
    currentWidth += wordWidth;
  }
  if (current.length) lines.push(current);
  return lines.length ? lines.map(renderTokens) : [""];
}

/** Inline-styles one source line and lays it out under a first/continuation prefix. */
function renderInline(text: string, width: number, firstPrefix: string, contPrefix: string): string {
  const lines = wrapRuns(tokenize(parseInline(text)), width - visibleWidth(firstPrefix));
  return lines.map((line, index) => (index === 0 ? firstPrefix : contPrefix) + line).join("\n");
}

/** Wraps unstyled text (headers, quotes) whose styling is applied to the whole line. */
function wrapPlain(text: string, available: number): string[] {
  return wrapRuns(tokenize([{ text, open: "", close: "" }]), available);
}

export function createRenderer(options: MarkdownOptions = {}): StreamRenderer {
  const width = Math.max(MIN_WIDTH, options.width ?? terminalWidth());
  let buffer = "";
  let inFence = false;

  /** Returns the styled line, or `null` when the source line vanishes entirely (fence markers). */
  const renderLine = (raw: string): string | null => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const fence = FENCE.exec(line);
    if (fence) {
      if (inFence) {
        inFence = false;
        return null;
      }
      inFence = true;
      // Opening fence: only the language tag is worth a line of its own.
      return fence[1] ? `  ${dim(fence[1])}` : null;
    }
    if (inFence) {
      // Code is never rewrapped and never inline-parsed — its whitespace is meaning.
      return `  ${dim("│")} ${line}`;
    }
    if (!line.trim()) return "";
    const header = HEADER.exec(line);
    if (header) {
      const style = header[1].length <= 2 ? accentBold : bold;
      return wrapPlain(header[2], width).map(style).join("\n");
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      const indent = quote[1];
      return wrapPlain(quote[2], width - indent.length - 2)
        .map((piece) => `${indent}${dim("│")} ${dim(italic(piece))}`)
        .join("\n");
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      const indent = bullet[1];
      return renderInline(bullet[2], width, `${indent}${accent("•")} `, `${indent}  `);
    }
    const numbered = NUMBERED.exec(line);
    if (numbered) {
      const [, indent, marker, rest] = numbered;
      return renderInline(rest, width, `${indent}${accent(marker)} `, `${indent}${" ".repeat(marker.length + 1)}`);
    }
    const indent = /^\s*/.exec(line)?.[0] ?? "";
    return renderInline(line.slice(indent.length), width, indent, indent);
  };

  return {
    write(chunk: string): string {
      // Identity in plain mode: no buffering, no rewrapping, byte-for-byte passthrough.
      if (!isColor()) return chunk;
      buffer += chunk;
      let out = "";
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const rendered = renderLine(buffer.slice(0, newline));
        if (rendered !== null) out += `${rendered}\n`;
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      return out;
    },
    flush(): string {
      const held = buffer;
      buffer = "";
      if (!isColor() || !held) {
        inFence = false;
        return "";
      }
      const rendered = renderLine(held);
      inFence = false;
      return rendered === null ? "" : `${rendered}\n`;
    },
  };
}

/** Pure one-shot render — the snapshot-test entry point and the non-streaming path. */
export function renderMarkdown(text: string, options: MarkdownOptions = {}): string {
  const renderer = createRenderer(options);
  return renderer.write(text) + renderer.flush();
}
