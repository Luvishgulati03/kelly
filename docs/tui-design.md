# Henry terminal interaction design (the TUI spec)

Goal: a Claude Code / codex-cli-class terminal experience —
polished, fast, legible — with ZERO new npm dependencies (hand-rolled ANSI,
no ink/chalk/blessed) and no regression of the REPL's hard-won behaviors
(buffer-and-drain input queue, streaming truce with the spinner, reminder
lines above the prompt).

## Identity

- Henry: cyan accent. Prompt: `henry ❯ `. Boot banner: small HENRY wordmark
  (3-line unicode/ASCII, subtle, dim), one-line status underneath.
- NO_COLOR env and non-TTY output degrade to today's plain text —
  every visual is additive, never load-bearing.

## Elements

1. **Boot banner**: wordmark + one dim status line (provider · model seat ·
   dashboard URL · telegram/pump state). Then the prompt. Total ≤6 lines.
2. **Prompt line**: colored `❯` glyph, agent-name prefix dimmed. While a
   turn is queued behind a running one, prompt renders `… ❯` so queueing is
   visible (existing queue semantics unchanged).
3. **Spinner**: braille cycle (⣾⣽⣻⢿⡿⣟⣯⣷) + elapsed seconds, dim, replaced
   in-place; first streamed token clears it (existing truce: user keypress
   silences it — keep exactly).
4. **Streamed output rendering** (markdown-lite, applied per line as text
   streams): `# `/`## ` headers → bold accent; `**bold**` → bold; `` `code` ``
   → reverse-dim span; fenced code blocks → 2-space indent with dim
   background bar and language tag; `- ` bullets → `•`; numbered lists kept;
   `> ` quotes → dim italic bar. Word-wrap to terminal width (min 40, reflow
   on resize not required). Renderer is a PURE function (string in →
   ANSI string out) so it's snapshot-testable.
5. **Result panels**: structured command output (`:status`, standup digests,
   scout summaries) rendered in rounded unicode boxes (╭─╮│╰╯) with a
   title tab and dim borders; two-column key/value layout, right-aligned
   numbers. Pure helper `panel(title, rows | text)`.
6. **Severity glyphs**: `✓` green, `✗` red, `⚠` yellow, `◆` accent info —
   used consistently by REPL messages (dashboard up, telegram watching,
   reminder fired, provider fallback...).
7. **:help**: a real panel — grouped commands with one-line descriptions,
   accent-colored command names — generated from a declarative table so
   help can't drift from reality.
8. **Reminder/notification lines** that arrive mid-session print above the
   prompt with a `◆` prefix and re-render the preserved prompt (existing
   safePrompt(true) machinery — reuse, don't rebuild).

## Module layout (mirrored in both repos)

- `src/tui/ansi.ts` — color/style primitives, NO_COLOR + TTY detection,
  width helpers (grapheme-safe enough: code-point width, wide-char aware
  for CJK not required v1).
- `src/tui/markdown.ts` — the pure streaming renderer (feed chunks, emits
  styled chunks; internal line buffer for block constructs).
- `src/tui/panel.ts` — boxes, tables, glyphs, banner.
- REPL integration: replace raw `console.log`/`process.stdout.write` call
  sites in the REPL loop and command handlers; the agent's streamed text
  goes through markdown.ts; command results through panel.ts.

## Tests

Pure-renderer snapshot tests (fixed input → exact ANSI string with a
FORCE_COLOR test seam), wrap-width cases, NO_COLOR degradation equals
plain input, panel box-drawing alignment with wide content, glyph helpers.
REPL integration keeps existing repl/input-queue tests green untouched.

## Out of scope v1 (record, don't build)

Full-screen alt-buffer UI, mouse, resize reflow, themes beyond the two
accents, per-token syntax highlighting inside code fences.
