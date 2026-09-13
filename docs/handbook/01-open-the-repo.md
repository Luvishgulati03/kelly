# Stage 1: Welcome And Laptop Setup

Goal: get Henry running from a safe local checkout and understand what the repo
contains before changing it.

## Do

Confirm the repo and local instructions:

```bash
pwd
git status --short
sed -n '1,180p' AGENTS.md
sed -n '1,220p' README.md
sed -n '1,220p' SETUP.md
```

Confirm the laptop prerequisites:

```bash
node -v
npm -v
git --version
```

Install and verify:

```bash
npm install
npm link
npx tsc --noEmit
npm test
henry provider codex
henry ask "Reply with: Henry is ready"
```

## Check

The repo should be outside cloud-synced folders. `SETUP.md` specifically warns
against iCloud, Dropbox, and OneDrive paths because evicted dependency files can
make TypeScript or Node hang instead of fail.

`package.json` currently defines:

```text
npm run dev        # tsx src/cli.ts repl
npm run start      # tsx src/cli.ts repl
npm run dashboard  # tsx src/cli.ts dashboard
npm run schedule   # tsx src/cli.ts schedule daemon
npm run typecheck  # tsc --noEmit
npm test           # tsx --import ./tests/isolate.mjs --test-concurrency=1 --test tests/**/*.test.ts
npm run build      # compile TypeScript into dist/
```

`npm link` installs the global `henry` command from `bin/henry.mjs`. If you do
not want a global link, replace `henry` in this handbook with
`node bin/henry.mjs`.

Authenticate one provider before the first real question, then select it:

```bash
codex login status
codex login
henry provider codex
henry provider
```

For Claude, use `claude auth status`, `claude auth login`, and
`henry provider claude` instead. You only need one working provider.

## Learn

Henry's kernel wires the CLI, dashboard, provider runner, memory, approval
store, scheduler, and optional modules. Local state belongs outside Git:
`.env`, `soul.md`, `personality.md`, `data/`, `memory/`, and `knowledge/`.

## Record

```md
Repo path:
Current branch:
Synced folder risk:
Node version:
npm install result:
Typecheck result:
Test result:
Global command or local entrypoint:
Selected provider:
First answer received:
```

---

Previous: [Handbook README](README.md) | Next: [Stage 2: IDEATION](02-install-and-verify.md)
