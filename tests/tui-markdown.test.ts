import test from "node:test";
import assert from "node:assert/strict";
import { setColorEnabled, visibleWidth } from "../src/tui/ansi.ts";
import { createRenderer, renderMarkdown } from "../src/tui/markdown.ts";

/** Every snapshot below runs as if FORCE_COLOR=1 — no terminal required. */
const colored = (text: string, width = 80): string => {
  setColorEnabled(true);
  return renderMarkdown(text, { width });
};

test("snapshot: headers become bold accent, level 3+ stays bold", () => {
  assert.equal(colored("# Today's changes\n"), "\x1b[1;36mToday's changes\x1b[22;39m\n");
  assert.equal(colored("## Section\n"), "\x1b[1;36mSection\x1b[22;39m\n");
  assert.equal(colored("### Deeper\n"), "\x1b[1mDeeper\x1b[22m\n");
});

test("snapshot: **bold** and `code` spans, with spaces keeping the style they came from", () => {
  assert.equal(colored("a **b** c\n"), "a \x1b[1mb\x1b[22m c\n");
  // The space INSIDE a code span stays reverse-dim, so the highlight has no gap.
  assert.equal(colored("run `npm test` now\n"), "run \x1b[2;7mnpm test\x1b[27;22m now\n");
  // Unclosed markers are literal text, never a style that eats the rest of the line.
  assert.equal(colored("half **open and `tick\n"), "half **open and `tick\n");
  assert.equal(colored("empty `` span\n"), "empty `` span\n");
});

test("snapshot: bullets become •, numbered markers are kept, quotes get a dim italic bar", () => {
  assert.equal(colored("- alpha\n"), "\x1b[36m•\x1b[39m alpha\n");
  assert.equal(colored("* alpha\n"), "\x1b[36m•\x1b[39m alpha\n");
  assert.equal(colored("  - nested\n"), "  \x1b[36m•\x1b[39m nested\n");
  assert.equal(colored("1. first\n"), "\x1b[36m1.\x1b[39m first\n");
  assert.equal(colored("> hush\n"), "\x1b[2m│\x1b[22m \x1b[2m\x1b[3mhush\x1b[23m\x1b[22m\n");
});

test("snapshot: a fence indents its body behind a dim bar, tags the language, and eats its markers", () => {
  assert.equal(
    colored("```ts\nconst a = 1;\n```\n"),
    "  \x1b[2mts\x1b[22m\n  \x1b[2m│\x1b[22m const a = 1;\n",
  );
  // No language tag → no stray line at all.
  assert.equal(colored("```\nplain\n```\n"), "  \x1b[2m│\x1b[22m plain\n");
  // Code is never inline-parsed and never rewrapped: its whitespace is meaning.
  assert.equal(
    colored("```\n  **not bold**   spaced\n```\n"),
    "  \x1b[2m│\x1b[22m   **not bold**   spaced\n",
  );
});

test("blank lines survive, trailing \\r from CRLF text does not", () => {
  assert.equal(colored("a\n\nb\n"), "a\n\nb\n");
  assert.equal(colored("a\r\nb\r\n"), "a\nb\n");
});

test("word wrap honours the given width, hangs bullet continuations, and floors at 40", () => {
  assert.equal(
    colored("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu\n", 40),
    "alpha beta gamma delta epsilon zeta eta\ntheta iota kappa lambda mu\n",
  );
  // Continuations of a bullet line up under the text, not under the •.
  assert.equal(
    colored("- alpha beta gamma delta epsilon zeta eta theta iota\n", 40),
    "\x1b[36m•\x1b[39m alpha beta gamma delta epsilon zeta\n  eta theta iota\n",
  );
  // A width below the spec's floor is raised to 40 rather than obeyed.
  const narrow = colored("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu\n", 10);
  assert.equal(narrow, colored("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu\n", 40));
  // An unbreakable word is hard-split instead of blowing out the right edge.
  const url = colored(`see https://example.com/${"a".repeat(60)} ok\n`, 40);
  for (const line of url.split("\n")) assert.ok(visibleWidth(line) <= 40, `too wide: ${JSON.stringify(line)}`);
});

const DOC = [
  "# Head",
  "",
  "some **bold** and `code` here, plus a much longer sentence that has to wrap somewhere sensible",
  "",
  "```ts",
  "const a = 1;",
  "if (a) return a;",
  "```",
  "- item one",
  "- item two",
  "> quoted",
  "",
].join("\n");

test("chunk boundaries: any split of a document renders byte-identically to one shot", () => {
  setColorEnabled(true);
  const expected = renderMarkdown(DOC, { width: 60 });
  for (let cut = 0; cut <= DOC.length; cut += 1) {
    const renderer = createRenderer({ width: 60 });
    const actual = renderer.write(DOC.slice(0, cut)) + renderer.write(DOC.slice(cut)) + renderer.flush();
    assert.equal(actual, expected, `split at ${cut} diverged`);
  }
});

test("chunk boundaries: mid-word, mid-**, and mid-fence splits all reassemble", () => {
  setColorEnabled(true);
  const feed = (chunks: string[]): string => {
    const renderer = createRenderer({ width: 80 });
    return chunks.map((chunk) => renderer.write(chunk)).join("") + renderer.flush();
  };
  assert.equal(feed(["hello wo", "rld\n"]), "hello world\n");
  assert.equal(feed(["a *", "*b*", "* c\n"]), "a \x1b[1mb\x1b[22m c\n");
  assert.equal(feed(["run `npm ", "test` now\n"]), "run \x1b[2;7mnpm test\x1b[27;22m now\n");
  // A fence opened in one chunk and closed three chunks later still styles its body.
  assert.equal(
    feed(["```", "ts\n", "const a = 1;\n", "more();\n", "``", "`\nafter\n"]),
    "  \x1b[2mts\x1b[22m\n  \x1b[2m│\x1b[22m const a = 1;\n  \x1b[2m│\x1b[22m more();\nafter\n",
  );
});

test("the renderer never holds text back longer than one line", () => {
  setColorEnabled(true);
  const renderer = createRenderer({ width: 80 });
  const emitted = renderer.write("first line\nsecond partial");
  assert.equal(emitted, "first line\n");
  assert.equal(emitted.includes("second"), false);
  // A chunk that completes no line emits nothing at all…
  assert.equal(renderer.write(" continues"), "");
  // …and the held partial line is released the moment its newline arrives.
  assert.equal(renderer.write("\n"), "second partial continues\n");
  assert.equal(renderer.flush(), "");
});

test("flush releases an unterminated tail and resets fence state for the next turn", () => {
  setColorEnabled(true);
  const renderer = createRenderer({ width: 80 });
  assert.equal(renderer.write("```ts\ncode()"), "  \x1b[2mts\x1b[22m\n");
  assert.equal(renderer.flush(), "  \x1b[2m│\x1b[22m code()\n");
  // The next turn starts outside the fence even though the fence never closed.
  assert.equal(renderer.write("plain\n"), "plain\n");
});

test("NO_COLOR: the renderer is the identity function, streamed or in one shot", () => {
  setColorEnabled(false);
  const samples = [
    DOC,
    "# Head\n",
    "- bullet with **bold** and `code`\n",
    "> quote\n",
    "```ts\nconst a = 1;\n```\n",
    "a very long line that would otherwise be word wrapped by the renderer because it is well past eighty columns wide\n",
    "no trailing newline",
    "",
  ];
  for (const sample of samples) {
    assert.equal(renderMarkdown(sample, { width: 40 }), sample);
    const renderer = createRenderer({ width: 40 });
    const streamed = [...sample].map((char) => renderer.write(char)).join("") + renderer.flush();
    assert.equal(streamed, sample);
  }
  assert.equal(renderMarkdown(DOC).includes("\x1b"), false);
});
