# Stage 6: Grow Through Surfaces, Schedules, And Approval

Goal: connect more ways to use Henry without broadening its authority.

## Do

Read the surface and automation docs:

```bash
sed -n '1,220p' docs/modules/workflows.md
sed -n '1,220p' docs/modules/gmail.md
sed -n '1,180p' docs/modules/telegram.md
sed -n '1,120p' docs/modules/pr-review.md
```

Try local surfaces:

```bash
henry ask "what can you do from this checkout?"
henry repl
henry dashboard
henry status
```

`henry dashboard` occupies its terminal and prints the loopback URL, normally
`http://127.0.0.1:7337`. Keep `HENRY_HOST=127.0.0.1`; do not expose approval
controls or a full-access provider on an unauthenticated network interface.

Connect your private Telegram DM only if you want phone access:

1. Create a bot with [@BotFather](https://t.me/BotFather) using `/newbot`.
2. Message the bot once and obtain the chat id as described in
   [the Telegram module guide](../modules/telegram.md).
3. Set `HENRY_TELEGRAM_BOT_TOKEN` and `HENRY_TELEGRAM_CHAT_ID` in `.env`.
4. Verify and enable the bridge:

```bash
henry telegram test
henry telegram status
henry telegram on
henry repl
```

The configured DM is allowlisted. Operator mode is optional and still cannot
approve, push, merge, deploy, post, send mail, or bypass destructive-command
rails:

```bash
henry telegram operator on
henry telegram operator off
```

Inspect schedules and workflows:

```bash
henry schedule list
henry workflow list
henry schedule install
```

Bare `schedule install` only generates reviewable files. Actual installation is
explicit and reversible:

```bash
henry schedule install --launchd   # macOS user LaunchAgent
henry schedule install --cron      # marked block in the user's crontab
henry schedule status
henry schedule uninstall --launchd
henry schedule uninstall --cron
```

Inspect approvals:

```bash
henry approve list
```

Stage a manual email only in a private configured setup:

```bash
henry draft mail --to person@example.com --subject "Test" --body "This is a staged draft."
henry approve list
```

## Check

Approval commands are separate:

```text
henry approve list
henry approve approve <id>
henry approve send <id>
```

Scheduling commands exist as:

```text
henry schedule list|run <id>|daemon|install|status|uninstall
henry workflow list|show <name>|run <name>|logs <name>|daemon
```

## Learn

Growth means adding surfaces and repeatable workflows while keeping execution
rules stable. Dashboard, REPL, Telegram, scheduler, Gmail drafting, and PR review
should all converge on the same runtime and approval store.

Approving and executing are separate operations. A scheduled job or casual
"go ahead" does not approve an outbound item.

## Record

```md
Surface tested:
Schedule inspected:
Workflow inspected:
Approval queue state:
Outbound item staged:
Execution authority:
```

---

Previous: [Stage 5: Memory Vs Knowledge](05-talk-to-henry.md) | Next: [Stage 7: Daily Demo Path](07-build-knowledge.md)
