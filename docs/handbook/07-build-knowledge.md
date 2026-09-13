# Stage 7: Daily Demo Path

Goal: run a short, truthful demo that shows Henry's daily operating loop without
claiming external work happened.

## Do

Start with health:

```bash
henry status
henry provider
henry knowledge stats
henry approve list
```

Ask a repo-grounded question:

```bash
henry ask "Summarize the current Henry architecture and name the approval boundary."
```

Open the live surfaces:

```bash
henry repl
henry dashboard
```

Inside the REPL:

```text
:help
:status
:dashboard
:provider
:quit
```

Show automation without installing it:

```bash
henry schedule list
henry workflow list
henry remind "demo reminder" --in "10m"
henry remind list
```

Cancel the demo reminder:

```bash
henry remind cancel <id>
```

## Check

A truthful demo can show:

- A local dashboard URL, normally `http://127.0.0.1:7337`.
- The configured provider.
- Memory and knowledge status.
- A reminder staged locally.
- An approval queue that does not execute outbound work without explicit action.

## Learn

The demo path should show the system's real shape: local-first runtime,
subscription CLI provider, memory and knowledge stores, schedules, and approval.
Do not imply that a draft, notification, review, or staged item has been sent or
posted.

## Record

```md
Status output:
Provider:
Dashboard URL:
Reminder id:
Approval queue:
Demo claim checked:
```

---

Previous: [Stage 6: Grow Through Surfaces, Schedules, And Approval](06-use-memory.md) | Next: [Stage 8: Troubleshooting](08-automate-carefully.md)

