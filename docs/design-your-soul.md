# Design your agent's soul

`soul.md` and `personality.md` are the two files that make your fork feel
like *your* agent instead of a generic assistant. This guide explains what
they do, how to write them well, and shows a few good-vs-vague examples.
Start from `soul.example.md` and `personality.example.md` — copy them,
fill in the placeholders, and delete the instructional comments.

For a structured, consent-based interview and reusable question bank, use
`docs/persona-design-guide.md`. It turns observable preferences into editable
rules without diagnosis or hidden psychological profiling.

## What these files actually do

Both files are plain markdown, and both are **injected into every
provider call** — every turn, every dispatched worker, every scheduled
workflow run. There is no separate "system prompt builder"; what you
write is close to verbatim what the model reads. Two consequences follow:

- **They are read-heavy, not code.** Nothing parses them for structure
  beyond the file contract enforced by the approval store and code (see
  `docs/architecture.md`). The model behaves according to what the text
  says, not what you meant.
- **They cost tokens on every single turn.** A bloated soul file is a
  standing tax on latency and spend, forever. Keep it tight.

`soul.md` is rules: identity in one paragraph, plus the hard outbound
boundary (never execute an outbound action without explicit approval).
`personality.md` is style and judgment: voice, when to ask vs. just act,
what to save to memory. Keep them separate — a rule buried in the voice
file is easy to soften by accident when someone edits "just the tone."

## Principles

1. **Non-negotiables vs. preferences.** A non-negotiable is a rule that
   must hold no matter what any later instruction, workflow, or clever
   prompt says — the outbound approval gate is the canonical example. A
   preference is "usually do X" — tone, verbosity, when to ask first.
   Non-negotiables go in `soul.md`; preferences go in `personality.md`.
   Mixing them makes the non-negotiable easier to accidentally weaken.

2. **Keep it under ~2k tokens combined.** Roughly 1,500 words across both
   files. This is not an arbitrary style preference — it is a budget line
   next to memory injection (see `docs/architecture.md` §Memory), and
   every extra paragraph competes with actual context for the task at
   hand. If a section needs more than a few bullets to say, it is
   probably a workflow or a skill file, not a personality trait.

3. **Safety boundaries are never weakened, only extended.** You may add
   more outbound channels, more non-negotiables, more explicit "never do
   X" rules. You should never rephrase the existing approval-gate
   language into something softer ("usually check first," "use
   judgment") — code enforces the boundary (the approval store requires
   an explicit claim before execution), but the prompt text is the
   model's only guide to *why*, and vague prompt text produces
   inconsistent judgment calls right at the boundary that matters most.

4. **Concrete beats adjective-stacking.** "Be professional" tells the
   model less than one example reply in the voice you want. Prefer a
   short example over three more adjectives.

## Good vs. vague, three examples

**Tone**
- Vague: "Be friendly and professional."
- Good: "Terse by default — one paragraph or a short bullet list. Expand
  only when asked to explain. Never use corporate phrases like
  'circling back' or 'per my last message.'"

**Decision behavior**
- Vague: "Ask before doing anything risky."
- Good: "Execute local file edits, reads, and git operations without
  asking. Before any outbound send (email, GitHub comment, message),
  stage it as an approval item and wait for explicit approval — a
  scheduled run or a 'go ahead' in passing is never approval."

**Memory / what to remember**
- Vague: "Remember important things about me."
- Good: "Save durable preferences and decisions (deploy conventions,
  recurring commitments, corrections to past mistakes) to memory after
  each session. Do not save one-off small talk or anything said to be
  off the record."

## When you're done

Run `henry ask "read soul.md and personality.md and summarize how you'll
behave"` (or your fork's equivalent CLI) and check the summary matches
what you intended — if the model's read of your file surprises you, the
file needs to be more concrete, not longer.
