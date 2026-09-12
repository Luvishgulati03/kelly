import test from "node:test";
import assert from "node:assert/strict";
import { setColorEnabled, stripAnsi, visibleWidth } from "../src/tui/ansi.ts";
import {
  GLYPHS, HENRY_MARK, SPINNER_CLEAR_WIDTH, SPINNER_FRAMES, banner, clearLine, commandPanel, note,
  panel, prompt, spinnerStart, spinnerTick,
} from "../src/tui/panel.ts";

const lines = (box: string): string[] => box.split("\n");
const widths = (box: string): number[] => lines(box).map(visibleWidth);
/** A box is only a box if every one of its lines is exactly as wide as the others. */
const assertAligned = (box: string): void => {
  const seen = new Set(widths(box));
  assert.equal(seen.size, 1, `ragged box (widths ${[...seen].join(", ")}):\n${stripAnsi(box)}`);
};

test("panel draws a rounded box with a title tab, and every line is exactly as wide", () => {
  setColorEnabled(true);
  const box = panel("status", [
    { key: "provider", value: "codex" },
    { key: "dashboard", value: "http://127.0.0.1:4319" },
  ], { width: 60 });
  assertAligned(box);
  const plain = lines(stripAnsi(box));
  assert.match(plain[0], /^╭─ status ─+╮$/);
  assert.match(plain.at(-1)!, /^╰─+╯$/);
  assert.match(plain[1], /^│ provider {2,}codex +│$/);
  assert.equal(plain[2].includes("http://127.0.0.1:4319"), true);
  // The box hugs its content instead of always filling the terminal.
  assert.equal(visibleWidth(lines(box)[0]) < 60, true);
});

test("panel keeps alignment when a value is far too long to fit: it wraps under the value column", () => {
  setColorEnabled(true);
  const box = panel("status", [
    { key: "provider", value: "codex" },
    { key: "root", value: "/Users/luvishgulati/Downloads/henry-with-a-very-long-path/that/keeps/going/and/going" },
  ], { width: 50 });
  assertAligned(box);
  for (const width of widths(box)) assert.equal(width <= 50, true);
  const plain = lines(stripAnsi(box));
  const first = plain.findIndex((line) => line.includes("/Users/"));
  const continuation = plain[first + 1];
  // A wrapped value lines up under itself, never back under the key column.
  const valueColumn = plain[first].indexOf("/Users/");
  assert.equal(continuation.slice(0, valueColumn).trim(), "│", "continuation must be blank up to the value column");
  assert.notEqual(continuation[valueColumn], " ", "continuation must start exactly at the value column");
  assert.equal(continuation.includes("with-a-very-long-path"), true);
});

test("panel right-aligns numbers against each other so digits form a column", () => {
  setColorEnabled(false);
  const box = panel("memory", [
    { key: "approvals", value: 3 },
    { key: "memories", value: 1284 },
    { key: "provider", value: "codex" },
  ], { width: 60 });
  assertAligned(box);
  const plain = lines(box);
  const rightEdge = (line: string, token: string): number => line.indexOf(token) + token.length;
  assert.equal(rightEdge(plain[1], "3"), rightEdge(plain[2], "1284"));
  assert.equal(plain[1].indexOf("3") > plain[2].indexOf("1284"), true, "the narrower number must be pushed right");
  // A non-numeric value stays left-aligned at the start of the value column.
  assert.equal(plain[3].indexOf("codex"), plain[2].indexOf("1284"));
});

test("panel accepts free text, wrapping it inside the box", () => {
  setColorEnabled(false);
  const box = panel("note", "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda", { width: 30 });
  assertAligned(box);
  for (const width of widths(box)) assert.equal(width <= 30, true);
  assert.equal(lines(box).length > 3, true);
  assert.equal(stripAnsi(box).includes("lambda"), true);
});

test("panel survives a title wider than its rows, and an untitled box", () => {
  setColorEnabled(true);
  assertAligned(panel("a very long panel title indeed", [{ key: "k", value: "v" }], { width: 60 }));
  const untitled = panel("", ["just a line"], { width: 40 });
  assertAligned(untitled);
  assert.match(lines(stripAnsi(untitled))[0], /^╭─+╮$/);
});

test(":help is generated from the declarative table — every command and summary appears", () => {
  setColorEnabled(true);
  const commands = [
    { name: ":help", summary: "this panel", group: "session" },
    { name: ":status", summary: "provider, dashboard, approvals", group: "session" },
    { name: ":memory", args: "<query>", summary: "search Henry's memory", group: "knowledge" },
  ];
  const box = commandPanel("henry · commands", commands, { width: 70 });
  assertAligned(box);
  const plain = stripAnsi(box);
  for (const command of commands) {
    assert.equal(plain.includes(command.name), true, `missing ${command.name}`);
    assert.equal(plain.includes(command.summary), true, `missing summary for ${command.name}`);
  }
  assert.equal(plain.includes(":memory <query>"), true);
  assert.equal(plain.includes("session"), true);
  assert.equal(plain.includes("knowledge"), true);
  // Command names carry the accent; group headings are dim.
  assert.equal(box.includes("\x1b[36m:help\x1b[39m"), true);
  assert.equal(box.includes("\x1b[2msession\x1b[22m"), true);
});

test("banner: wordmark + one status line + a blank, leaving the prompt inside the 6-line budget", () => {
  setColorEnabled(true);
  const rendered = banner({ status: ["codex", "http://127.0.0.1:4319", "telegram: watching"], width: 70 });
  const out = lines(rendered);
  assert.equal(out.length, 5);
  assert.equal(out.length + 1 <= 6, true, "banner + prompt must fit in 6 lines");
  assert.deepEqual(out.slice(0, 3).map(stripAnsi), HENRY_MARK);
  assert.equal(stripAnsi(out[3]), "codex · http://127.0.0.1:4319 · telegram: watching");
  assert.equal(out[4], "");
  for (const width of widths(rendered)) assert.equal(width <= 70, true);
});

test("banner: non-TTY / NO_COLOR collapses to a single plain line with no escapes", () => {
  setColorEnabled(false);
  const rendered = banner({ status: ["codex", "http://127.0.0.1:4319", "telegram: watching"], width: 70 });
  assert.equal(rendered.includes("\n"), false);
  assert.equal(rendered.includes("\x1b"), false);
  assert.equal(rendered, "HENRY · codex · http://127.0.0.1:4319 · telegram: watching");
  // An over-long status is truncated rather than wrapped into a second line.
  const narrow = banner({ status: ["codex", "x".repeat(200)], width: 40 });
  assert.equal(visibleWidth(narrow), 40);
  assert.equal(narrow.endsWith("…"), true);
});

test("severity glyphs are consistent and survive NO_COLOR without their color", () => {
  setColorEnabled(true);
  assert.equal(note("ok", "dashboard up"), "\x1b[32m✓\x1b[39m dashboard up");
  assert.equal(note("err", "send failed"), "\x1b[31m✗\x1b[39m send failed");
  assert.equal(note("warn", "provider fallback"), "\x1b[33m⚠\x1b[39m provider fallback");
  assert.equal(note("info", "reminder"), "\x1b[36m◆\x1b[39m reminder");
  setColorEnabled(false);
  assert.equal(note("ok", "dashboard up"), "✓ dashboard up");
  assert.equal(note("info", "reminder"), "◆ reminder");
  assert.deepEqual(GLYPHS, { ok: "✓", err: "✗", warn: "⚠", info: "◆" });
});

test("spinner: braille cycle when colored, the REPL's original text when not", () => {
  setColorEnabled(true);
  assert.deepEqual(SPINNER_FRAMES, ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"]);
  assert.equal(spinnerStart(), "\x1b[2m⣾ thinking…\x1b[22m");
  assert.equal(spinnerTick(0, 3), "\x1b[2m⣾ thinking… 3s\x1b[22m");
  assert.equal(spinnerTick(9, 12), "\x1b[2m⣽ thinking… 12s\x1b[22m");
  // The clear is narrower than the terminal floor, so erasing never wraps a line.
  assert.equal(visibleWidth(spinnerTick(3, 999)) < SPINNER_CLEAR_WIDTH, true);

  setColorEnabled(false);
  // Byte-identical to pre-TUI Henry: `process.stdout.write("henry is thinking… ")`.
  assert.equal(spinnerStart(), "henry is thinking… ");
  assert.equal(spinnerTick(0, 3), "henry is thinking… 3s ");
  assert.equal(spinnerTick(5, 42), "henry is thinking… 42s ");
  assert.equal(visibleWidth(spinnerTick(0, 9999)) <= SPINNER_CLEAR_WIDTH, true);
});

test("clearLine erases exactly the columns the spinner used, in place", () => {
  assert.equal(SPINNER_CLEAR_WIDTH, 28);
  assert.equal(clearLine(), `\r${" ".repeat(28)}\r`);
  assert.equal(clearLine(4), "\r    \r");
});

test("prompt: `henry ❯ ` / `… ❯ ` with color, the original `henry> ` without", () => {
  setColorEnabled(true);
  assert.equal(prompt(), "\x1b[2mhenry\x1b[22m \x1b[36m❯\x1b[39m ");
  assert.equal(stripAnsi(prompt()), "henry ❯ ");
  // Queueing is visible in the prompt itself while a turn is in flight.
  assert.equal(stripAnsi(prompt({ queued: true })), "… ❯ ");
  assert.equal(stripAnsi(prompt({ name: "bose" })), "bose ❯ ");
  setColorEnabled(false);
  assert.equal(prompt(), "henry> ");
  assert.equal(prompt({ queued: true }), "henry> ");
});
