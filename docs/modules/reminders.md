# Module: reminders

**You are Claude Code, Codex, or another coding agent, reading this inside
Henry's repo.** Already implemented at `src/reminders/service.ts` and
`src/reminders/ticker.ts` — don't rebuild it. Configure and verify only.

This is the closest module to the buildathon's cronjobs-module reference
(`vendor/buildathon/cronjobs-module/`), but it's a native kernel feature here,
not a bolt-on `schedule.js`/`scheduler.js` pair — it already auto-starts
inside every long-lived Henry process and already routes outbound sends
through the approval gate.

## 1. What it does

One-shot, recurring (cron), and approval-execution reminders — three kinds:

- `"message"` — delivers literal text (macOS notification + console) at fire
  time.
- `"prompt"` — runs the text through the full Henry agent at fire time and
  delivers the *response*, not the instruction.
- `"approval.execute"` — executes an **already-approved** outbound action at
  fire time (e.g. "send that email at 6pm, but only if I approved it by
  then"). It never creates or approves anything — `assertOutboundExecutionClaim`
  still gates the actual send.

Commands it adds (`src/cli.ts`, `remind` branch):

```
henry remind "<text>" --at "YYYY-MM-DD HH:mm" | --in "2h" | --every "<cron>"
henry remind --prompt "<instruction>" --at|--in|--every ...
henry remind --execute-approval <approvalId> --at "YYYY-MM-DD HH:mm" | --in "2h"   # one-shot only, no --every
henry remind list
henry remind cancel <id>
```

## 2. Configure

No env keys — reminders are stored at a fixed path (`data/reminders.json`,
`0o600`) and there is nothing external to authenticate. The poll interval is
a constant, `REMINDER_POLL_MS = 60_000` (60s) in `src/reminders/ticker.ts`,
not currently env-overridable.

No one-time external setup. macOS notifications use `osascript` (already on
every Mac); on non-macOS the `spawn("osascript", ...)` call fails silently
and reminders still print to the console (`notifyReminder` always logs first,
the `osascript` call is best-effort).

## 3. How it wires to the brain

- **Runs inside every long-lived process, once**: `startReminderTicker()`
  (`src/reminders/ticker.ts`) is wired into `henry repl`, `henry dashboard`,
  and `henry schedule daemon` (via `WorkflowScheduler.armReminders()` in
  `src/scheduler/scheduler.ts`) — there is a process-level guard (`started`
  flag) so double-wiring inside one process is a no-op; separate `henry ...`
  invocations are separate processes, so exactly one ticker runs per process.
- **Prompt reminders** call back into `HenryAgent.run()` via the injected
  `promptRunner` — the same full pipeline (soul/personality/memory
  injection) as `henry ask`, not a stripped-down path.
- **Approval-execute reminders** call back into
  `HenryRuntime.executeApproval()` via the injected `executeApproval` —
  the exact function `henry approve send` uses, so a scheduled send has no
  privilege a manual send doesn't.
- **The free-form agent**: `HenryAgent.buildPrompt()` documents the full
  `remind` surface (one-shot, recurring, prompt jobs, and the three-step
  "draft → approve → scheduled send" flow) as commands the conversational
  agent should shell out to directly.

## 4. Verify

```bash
npx tsx src/cli.ts remind "test reminder" --in "1m"
# → { id, text: "test reminder", kind: "message", dueAt, status: "pending" }
npx tsx src/cli.ts remind list
# → shows it with nextFireAt/dueAt in the future
npx tsx src/cli.ts repl
# wait ~1 min inside the REPL: "[Henry reminder] test reminder" prints, plus a macOS notification
npx tsx src/cli.ts remind "standup" --every "0 9 * * 1-5"
npx tsx src/cli.ts remind list
# → status stays "pending" forever (recurring reminders never reach "fired"); cancel is the only way to stop it
npx tsx src/cli.ts remind cancel <id>
# → status -> "cancelled"; a cancelled reminder cannot be cancelled again (throws)
```

## 5. Disable

`ReminderService` is constructed unconditionally and is inert until a
reminder exists — creating zero reminders means the ticker's periodic check
finds nothing due and does nothing. To fully suppress delivery in a given
process, don't start `henry repl`/`henry dashboard`/`henry schedule daemon`
(the only places `startReminderTicker`/`armReminders` are called) — a bare
`henry remind ...` CLI invocation creates or lists reminders but does not
itself keep a process alive to fire them.
