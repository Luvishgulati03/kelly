# Module: telegram

**You are Claude Code, Codex, or another coding agent, reading this inside
Henry's repo.** Already implemented at `src/notify/telegram.ts` — don't
rebuild it. Configure and verify only.

## 1. What it does

`sendTelegram(config, text)` posts `text` to Luvish's own Telegram chat via the
Bot API (`sendMessage`). It is a **fire-and-forget, fail-open** notification
channel layered on top of the existing console + macOS-notification path
(`notifyReminder` in `src/reminders/service.ts`) — it never replaces it and
never throws. Any failure (unconfigured, network error, timeout, non-2xx
response) returns `false` silently.

**SCOPE-GUARD**: this is an operator-notification channel only. `chat_id`
always comes from config — Luvish's own chat — and is never accepted as a
caller-supplied parameter. It is never a general send-to-anyone surface;
outbound messages to other people still stage through the `ApprovalStore`
exactly as before.

Where it's wired in (composed once, in `src/runtime.ts`, as
`HenryRuntime.notifyOperator`):

- `henry schedule daemon` — the scheduler's reminder ticker and the
  `mail.watch` workflow both notify through it.
- `henry dashboard` — its reminder ticker notifies through it.
- `henry telegram test` — a direct one-off send for setup verification.

`henry repl`'s reminder ticker intentionally keeps its own terminal-echo
notifier (the message prints above the prompt Luvish is already watching) and
does not also fire Telegram.

## 2. Configure

1. **Create the bot** — message [@BotFather](https://t.me/BotFather) on
   Telegram:
   ```
   /newbot
   ```
   Follow the prompts (choose a name, then a username ending in `bot`).
   BotFather replies with an HTTP API token that looks like
   `123456789:AAExampleTokenTextGoesHere`. That's `HENRY_TELEGRAM_BOT_TOKEN`.

2. **Get your chat id** — open a DM with your new bot and send it any
   message (e.g. "hi"), then run:
   ```bash
   curl -s "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates"
   ```
   Find `"chat":{"id":<NUMBER>, ...}` in the response — that number
   (may be negative for group chats) is `HENRY_TELEGRAM_CHAT_ID`. If the
   response has an empty `"result":[]`, you haven't messaged the bot yet —
   send it a message and re-run the curl command.

3. **Add to `.env`**:
   ```
   HENRY_TELEGRAM_BOT_TOKEN=123456789:AAExampleTokenTextGoesHere
   HENRY_TELEGRAM_CHAT_ID=987654321
   ```

No other setup. `HenryConfig.telegramBotToken` / `telegramChatId` are read
via the same `HENRY_<name>` (falling back to `LAVU_<name>`) convention as
every other env-backed config field (`src/config.ts`).

## 3. Verify

```bash
npx tsx src/cli.ts telegram test
# → "ok — check your Telegram chat" and a "Henry → Telegram is live 🎉"
#   message arrives in the configured chat within a few seconds
```

If it prints `fail — check HENRY_TELEGRAM_BOT_TOKEN / HENRY_TELEGRAM_CHAT_ID
in .env, then see docs/modules/telegram.md`, re-check step 2/3 above — most
commonly the chat id wasn't captured because the bot was never messaged
first.

## 4. Disable

Remove (or blank out) `HENRY_TELEGRAM_BOT_TOKEN` and
`HENRY_TELEGRAM_CHAT_ID` from `.env` and restart any running Henry process.
`sendTelegram` no-ops (returns `false` immediately) whenever either key is
missing — every notification path still delivers via console + macOS
notification exactly as before; only the Telegram leg is skipped.

## 5. Two-way DM bridge (Luvish texts the bot, Henry answers)

Once steps 1–3 are done the bridge is ON by default — nothing else to install.
Text your configured Telegram bot and Henry replies in the chat, using the same brain the
REPL and the dashboard chat use (memory, intent tiers, sessions).

It runs inside a long-lived process, so exactly one of these must be open:

```bash
npx tsx src/cli.ts repl            # prints: Telegram: watching your DM (two-way) [+ the team group]
npx tsx src/cli.ts schedule daemon # same, headless
```

Check it:

```bash
npx tsx src/cli.ts telegram status  # env presence, kill-switch state, replies/dropped/deferred counters
npx tsx src/cli.ts telegram off     # kill switch → telegram.bridge.enabled=false in data/settings.json
npx tsx src/cli.ts telegram on
npx tsx src/cli.ts telegram operator on   # opt in to local code edits/tests/link research from your DM
npx tsx src/cli.ts telegram operator off
```

Rails worth knowing:

- **Luvish only.** `HENRY_TELEGRAM_CHAT_ID` is the one chat that ever gets a
  reply. Any other DM is counted in the activity log and dropped — no reply,
  and its text is never read, logged, or stored.
- **Conversation, not mutation.** Bridge runs are `readOnly`. Destructive or
  long-running asks (git push, deploy, `npm install`, "run the test suite",
  "refactor the X module") are answered with "do that in the terminal session"
  and never reach the provider.
- **One at a time.** Strictly sequential; up to 5 messages queue behind the
  in-flight one, older ones are dropped and the next reply says so.
- **One poller.** `src/telegram/pump.ts` is the single `getUpdates` consumer for
  the bot token — a second consumer would steal updates. It routes by chat id:
  your DM → the bridge, `HENRY_TELEGRAM_STANDUP_CHAT_ID` → standup's unchanged
  intake, everything else → counted and dropped. Lock and offset rows
  (`poller:lock`, `poller:lastUpdateId`) are shared with the legacy standup
  poller so the two can never poll side by side.

## Optional operator mode

Operator mode is an explicit opt-in for Luvish's own DM. It lets Henry inspect
and edit the local Henry repository, run its checks, and research URLs that
Luvish shares. It does not bypass approvals: Telegram cannot push, merge,
deploy, post, send mail, approve an action, or perform destructive commands.

```bash
henry telegram operator on
henry repl                 # or: henry dashboard / henry schedule daemon
```

Restart the long-lived process after changing the mode. Use `operator off` for
a conversation-only phone surface; `telegram status` reports the current mode.
