---
name: worklog
enabled: true
description: Daily operational update of what actually shipped in the last 24 hours.
triggers:
  - type: schedule
    cron: "30 18 * * *"
    timezone: Asia/Kolkata
  - type: command
    command: worklog
outputs:
  - type: docs
    path: data/workflow-runs/worklog
runner:
  tier: t1
  timeoutMs: 600000
concurrency: skip
---

You are writing the operator's daily worklog: a compact operational update of what actually
shipped in the last 24 hours. Everything you need about the environment is in the runtime
context JSON above — never hard-code paths, repository names, or dates.

## Inputs

The repository to report on is `henry.rootDir` from the runtime context. Report only on the
repositories you are given, and say nothing about repositories you were not given.

Gather the last 24 hours of real work:

```
git -C <repo> log --since="24 hours ago" --no-merges --date=short \
    --pretty=format:'%h|%ad|%an|%s'
git -C <repo> log --since="24 hours ago" --merges --pretty=format:'%h|%s'
git -C <repo> diff --stat "@{24 hours ago}" HEAD
git -C <repo> status --short
```

Read only. Do not commit, push, stash, checkout, or modify anything in any repository.
If a command fails (no commits in range, not a git repo, detached state), note it in one
line and continue — a partial worklog is worth more than a failed run.

Do not read customer data, catalogue databases, or quotation exports for this update. This
is a record of engineering work, not of the shop's trading activity.

## What to write

Group the raw commits into **meaningful accomplishments**, not a commit dump. A single
accomplishment usually spans several commits ("catalogue import: review gate, duplicate
detection, CLI"). Lead with the outcome, then the evidence.

Structure the artifact exactly like this:

```markdown
# Worklog — <YYYY-MM-DD>

## Shipped
- <accomplishment> — <one line of why it matters> (<short shas>)

## In flight
- <work visibly started but not finished: uncommitted changes, WIP branches>

## Notes
- <anything the operator should know: failures, risky changes, things that need a decision>
```

Rules:
- Skip any section that has no real content — do not pad.
- Facts only, from git output. Never invent work, never estimate progress percentages.
- Keep the whole thing under ~400 words; this is an operational update, not a report.
- Mention counts (files changed, commits) only when they carry signal.
- If there were no commits in the window, say exactly that in one line and stop.

Output the finished markdown as your final message. Do not write it to disk yourself —
Kelly writes your response to the artifact path in the runtime context.
