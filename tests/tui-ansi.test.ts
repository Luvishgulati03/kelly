import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_WIDTH, accent, accentBold, bold, dim, isColor, italic, padEnd, padStart, refreshColor,
  resolveColor, reverseDim, setAccent, setColorEnabled, stripAnsi, terminalWidth, truncate,
  visibleWidth, wrapWords,
} from "../src/tui/ansi.ts";

test("color support: NO_COLOR wins over everything, FORCE_COLOR wins over a non-TTY", () => {
  // The user asking for plain text is not overridable — that is the no-color.org contract.
  assert.equal(resolveColor({ env: { NO_COLOR: "1", FORCE_COLOR: "1" }, isTTY: true }), false);
  assert.equal(resolveColor({ env: { NO_COLOR: "anything" }, isTTY: true }), false);
  // An EMPTY NO_COLOR is not a request for plain text.
  assert.equal(resolveColor({ env: { NO_COLOR: "" }, isTTY: true }), true);
  // The test seam: colors without a terminal.
  assert.equal(resolveColor({ env: { FORCE_COLOR: "1" }, isTTY: false }), true);
  assert.equal(resolveColor({ env: { FORCE_COLOR: "0" }, isTTY: false }), false);
  assert.equal(resolveColor({ env: { FORCE_COLOR: "false" }, isTTY: true }), true);
  // Plain TTY detection, plus the dumb-terminal escape hatch.
  assert.equal(resolveColor({ env: {}, isTTY: true }), true);
  assert.equal(resolveColor({ env: {}, isTTY: false }), false);
  assert.equal(resolveColor({ env: { TERM: "dumb" }, isTTY: true }), false);
});

test("refreshColor recomputes the live state that every style helper reads", () => {
  assert.equal(refreshColor({ env: { FORCE_COLOR: "1" }, isTTY: false }), true);
  assert.equal(isColor(), true);
  assert.equal(refreshColor({ env: { NO_COLOR: "1" }, isTTY: true }), false);
  assert.equal(isColor(), false);
});

test("style primitives emit exact SGR spans that close with their specific reset", () => {
  setColorEnabled(true);
  assert.equal(bold("x"), "\x1b[1mx\x1b[22m");
  assert.equal(dim("x"), "\x1b[2mx\x1b[22m");
  assert.equal(italic("x"), "\x1b[3mx\x1b[23m");
  assert.equal(accent("x"), "\x1b[36mx\x1b[39m");
  // Inline `code` is one combined span, so nothing can cancel half of it.
  assert.equal(reverseDim("x"), "\x1b[2;7mx\x1b[27;22m");
  assert.equal(accentBold("x"), "\x1b[1;36mx\x1b[22;39m");
  // Empty input never grows escape codes (keeps padded/blank cells clean).
  assert.equal(bold(""), "");
});

test("every style primitive is the identity function when color is off", () => {
  setColorEnabled(false);
  for (const style of [bold, dim, italic, accent, accentBold, reverseDim]) {
    assert.equal(style("henry"), "henry");
  }
});

test("the accent is switchable (Henry cyan / Bose green) and cyan is the default", () => {
  setColorEnabled(true);
  assert.equal(accent("x"), "\x1b[36mx\x1b[39m");
  setAccent("green");
  assert.equal(accent("x"), "\x1b[32mx\x1b[39m");
  assert.equal(accentBold("x"), "\x1b[1;32mx\x1b[22;39m");
  setAccent("cyan");
  assert.equal(accent("x"), "\x1b[36mx\x1b[39m");
});

test("widths are measured on what the eye sees, not on the bytes", () => {
  setColorEnabled(true);
  const styled = `${dim("henry")} ${accent("❯")} `;
  assert.equal(stripAnsi(styled), "henry ❯ ");
  assert.equal(visibleWidth(styled), 8);
  assert.equal(styled.length > 8, true);
  assert.equal(visibleWidth("⣾ thinking… 12s"), 15);
});

test("padEnd/padStart pad to VISIBLE width so box columns line up", () => {
  setColorEnabled(true);
  const cell = accent("ok");
  assert.equal(padEnd(cell, 5), `${cell}   `);
  assert.equal(padStart(cell, 5), `   ${cell}`);
  assert.equal(padEnd("toolong", 3), "toolong");
});

test("truncate cuts to visible columns and marks the cut with an ellipsis", () => {
  setColorEnabled(false);
  assert.equal(truncate("henry", 10), "henry");
  assert.equal(truncate("henry", 5), "henry");
  assert.equal(truncate("henry", 4), "hen…");
  assert.equal(visibleWidth(truncate("a".repeat(50), 20)), 20);
  assert.equal(truncate("henry", 0), "");
});

test("terminalWidth never drops below the spec's 40-column floor", () => {
  assert.equal(terminalWidth(120), 120);
  assert.equal(terminalWidth(20), MIN_WIDTH);
  assert.equal(MIN_WIDTH, 40);
  assert.equal(terminalWidth() >= MIN_WIDTH, true);
});

test("wrapWords packs greedily, hard-splits unbreakable words, and always returns a line", () => {
  assert.deepEqual(wrapWords("the quick brown fox jumps", 10), ["the quick", "brown fox", "jumps"]);
  assert.deepEqual(wrapWords("", 10), [""]);
  const long = wrapWords(`https://${"x".repeat(25)}.com short`, 10);
  assert.equal(long.every((line) => line.length <= 10), true);
  assert.equal(long.join("").includes("xxxxx"), true);
  assert.equal(long.at(-1), "short");
});
