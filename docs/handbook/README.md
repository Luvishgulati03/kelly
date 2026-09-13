# Henry Handbook

> [Open the visual HTML handbook](index.html) · Markdown remains available
> below for readers and coding agents.

Welcome. This handbook is a public, user-neutral path for learning Henry by
doing small verified steps on a laptop.

Want another coding agent to perform the setup with you? Use the
provider-neutral [SETUP-PROMPT.md](../../SETUP-PROMPT.md) with Codex, Claude
Code, Gemini CLI, or another terminal agent.

Henry is a terminal-first personal agent kernel. It runs through local provider
CLIs, keeps memory and knowledge local by default, exposes terminal and dashboard
surfaces, and stages outbound actions behind an approval boundary.

The checked-in example instructions and sample persona name the original operator
of this repository. Treat those as example content when forking Henry; the
handbook itself uses neutral language.

## Laptop Setup First

Use a local checkout, not a cloud-synced path. On macOS, avoid `~/Desktop`,
`~/Documents`, Dropbox, OneDrive, and anything under `Library/Mobile Documents`
unless sync is disabled. The setup guide documents a real failure mode where
cloud eviction of `node_modules` files makes `tsc`, `node`, or `npm` hang.

Minimum path:

```bash
node -v
npm -v
git --version
npm install
npm link
npx tsc --noEmit
npm test
henry provider codex
henry ask "Reply with: Henry is ready"
```

Choose one provider CLI and authenticate from the real user's terminal:

```bash
codex login status
codex login
claude auth status
claude auth login
```

The auth command syntax above was checked against the installed CLI help:
`codex login --help` exposes `login status`; `claude auth --help` exposes
`auth login` and `auth status`.

Choose the provider after authenticating it:

```bash
henry provider codex       # primary recommended setup
# or: henry provider claude
henry provider             # verify the persisted choice
```

Henry stores that choice in local settings. Model routing may choose a faster
or deeper tier inside the selected provider, but it does not remove persona,
memory, knowledge, safety, or task context. The public runner allows provider
fallback by default when another configured CLI is available. If you have only
one provider—or require strict provider pinning—set `providers.fallback` to
`false` in `data/settings.json`. Test both CLI seats before enabling fallback.

## Handbook Path

1. [Welcome And Laptop Setup](01-open-the-repo.md)
2. [IDEATION Stage](02-install-and-verify.md)
3. [Soul And Personality](03-shape-the-agent.md)
4. [BUILDING Stage: Reminder Module Walkthrough](04-choose-the-provider.md)
5. [Memory Vs Knowledge](05-talk-to-henry.md)
6. [Grow Through Surfaces, Schedules, And Approval](06-use-memory.md)
7. [Daily Demo Path](07-build-knowledge.md)
8. [Troubleshooting](08-automate-carefully.md)
9. [Extend And Review Safely](09-extend-safely.md)

Templates:

- [IDEATION.md](IDEATION.md)
- [BUILDING.md](BUILDING.md)

By the end, you will have a private agent persona, one verified provider, a
working terminal and dashboard, an optional Telegram connection, your own
memory/knowledge data, and a completed plan for your first custom module.

## Source Checks

This handbook was grounded in:

- `package.json`
- `src/cli.ts`
- `SETUP.md`
- `docs/architecture.md`
- `docs/design-your-soul.md`
- `docs/module-doctrine.md`
- `docs/modules/knowledge-base.md`
- `docs/modules/reminders.md`
- `docs/modules/workflows.md`
- `docs/modules/gmail.md`
- `docs/modules/telegram.md`
- `docs/modules/pr-review.md`

If a command or behavior changes in source, update the handbook after checking
the new implementation.
