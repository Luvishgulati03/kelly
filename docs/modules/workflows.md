# Module: workflows (scheduler)

**You are Claude Code, Codex, or another coding agent, reading this inside
Henry's repo.** Already implemented across `src/scheduler/scheduler.ts`
(legacy JSON engine) and `src/workflows/{engine,registry,executor,
scheduler-bridge,definition}.ts` (markdown engine) — don't rebuild either.
Configure and verify only.

## 1. What it does

Two cron-driven engines, both running from one daemon:

1. **Legacy JSON engine** (`workflows/defaults.json`) — a fixed set of
   built-in `kind`s: `"memory.dream"`, `"gmail.inbox"`, `"knowledge.distill"`.
   No custom prompts; each `kind` maps to a hardcoded handler in
   `WorkflowScheduler.run()`.
2. **Markdown engine** (`workflows/*.workflow.md`) — arbitrary,
   Luvish-authored workflows: YAML frontmatter (triggers, outputs, runner tier)
   plus a markdown body that's sent verbatim as the provider prompt. Files
   are hot-reloaded (`WorkflowRegistry.watch()`); artifacts are written under
   `data/workflow-runs/<name>/`.

Commands it adds (`src/cli.ts`, `schedule` and `workflow` branches):

```
henry schedule list                    # legacy JSON definitions
henry schedule run <id>                # run one legacy definition now
henry schedule daemon                  # runs BOTH engines: legacy cron + markdown cron, in one process
henry schedule install                 # writes a generated crontab/launchd plist for review (does not install it)

henry workflow list                    # markdown workflows + any parse problems
henry workflow show <name>
henry workflow run <name>              # run one markdown workflow now, writes an artifact
henry workflow logs <name>             # lists + prints the latest artifact
henry workflow daemon                  # markdown engine ONLY (no legacy JSON engine)
```

## 2. Configure

Env keys (`.env`, read by `src/config.ts`):

```
HENRY_WORKFLOWS_PATH=workflows/defaults.json   # default shown; the legacy JSON definitions file
HENRY_WORKFLOWS_DIR=workflows                  # default shown; where *.workflow.md files are hot-reloaded from
```

No external account setup — this module only orchestrates other modules
(memory, gmail, knowledge) and the provider CLI. A markdown workflow's
frontmatter controls its own runner:

```yaml
runner:
  tier: t0 | t1 | t2         # optional; dispatch tier (see docs/architecture.md §4)
  provider: codex | claude   # optional
  timeoutMs: 900000          # optional; per-run wall-clock envelope
outputs:
  - type: docs
    path: data/workflow-runs/<name>   # MUST be under this exact prefix — enforced by isAllowedDocsPath()
concurrency: skip | parallel  # optional; "skip" = don't start a new run while one is in flight
```

## 3. How it wires to the brain

- **Provider runner**: `WorkflowExecutor` (`src/workflows/executor.ts`) sends
  the markdown body straight to `ProviderRunner.run()` — the same shared
  runner as every other module, honoring `runner.tier`/`runner.provider`/
  `runner.timeoutMs` from frontmatter.
- **Legacy JSON `kind`s** call directly into kernel/module code:
  `memory.dream` → `HenryMemory.dream()`; `gmail.inbox` → `GmailService.inbox()`;
  `knowledge.distill` → a fresh, short-lived `KnowledgeBase` +
  `KnowledgeIngestor` pair guarded by a pid-lock file
  (`data/knowledge.lock`) so an overlapping manual distill can't collide.
- **Reminders piggyback on this daemon**: `henry schedule daemon` also calls
  `runtime.scheduler`'s `armReminders()`, so starting the scheduler daemon is
  sufficient to get reminders firing too (see `docs/modules/reminders.md`).
- **Output path sandbox**: every markdown workflow's `docs` output is
  validated by `isAllowedDocsPath()` (`src/workflows/definition.ts`) to stay
  inside `data/workflow-runs/<workflow-name>/` — no absolute paths, no `..`
  traversal — because a workflow file is Luvish-editable config, not trusted
  code.
- No approval-gate involvement for the engines themselves; a workflow whose
  prompt asks the agent to send email/etc. still goes through that module's
  own approval gate exactly as an interactive turn would.

## 4. Verify

```bash
npx tsx src/cli.ts schedule list
# → the 3 defaults.json entries (nightly-engram-dream, gmail-inbox-poll [disabled], knowledge-distill-nightly)
npx tsx src/cli.ts workflow list
# → memory-consolidation, release-notes, worklog, worktree-prune (the shipped *.workflow.md files), no "invalid" key if all parse cleanly
npx tsx src/cli.ts workflow run memory-consolidation
# → { ...WorkflowRunResult... }; then:
npx tsx src/cli.ts workflow logs memory-consolidation
# → prints the newest artifact's path and full contents under data/workflow-runs/memory-consolidation/
npx tsx src/cli.ts schedule daemon
# → "Henry scheduler is running (<N> markdown workflow schedules armed). Press Ctrl+C to stop."
```

## 5. Disable

Nothing runs on a schedule unless a daemon (`henry schedule daemon` or
`henry workflow daemon`) is actually started — neither is auto-started by
`henry repl`/`henry dashboard`. To disable one specific legacy workflow, set
`"enabled": false` on its entry in `workflows/defaults.json` (this is already
the default for `gmail-inbox-poll`). To disable one specific markdown
workflow, set `enabled: false` in its frontmatter, or delete/move the
`*.workflow.md` file out of `HENRY_WORKFLOWS_DIR` — the registry only loads
files ending in `.workflow.md` from that directory.
