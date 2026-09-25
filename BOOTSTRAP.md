# Bootstrap Kelly

This file used to hold a long bootstrap prompt from the Henry runtime. For Kelly
it is replaced by two files:

- [SETUP-PROMPT.md](SETUP-PROMPT.md): the guided conversation a coding agent
  runs with the shop owner, then the ordered setup steps with a check for each.
- [SETUP.md](SETUP.md): the full runbook with exact commands, the voice stack,
  tablet setup, public link options, Telegram, troubleshooting, and a final
  "verify it works" checklist.

To start, open Claude Code or Codex inside a fresh clone and say:

```text
Set up this repository as Kelly for my shop. Read CLAUDE.md (or AGENTS.md),
SETUP-PROMPT.md, and SETUP.md completely, then follow SETUP-PROMPT.md.
```
