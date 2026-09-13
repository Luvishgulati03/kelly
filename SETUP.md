# Setting up Henry

> **Kelly note.** This runbook documents the shared Henry runtime Kelly is built
> on. For Kelly, substitute `kelly` for `henry`, `KELLY_` for `HENRY_`, and
> `KELLY.env.example` for `.env.example`. Kelly keeps its state in `~/.kelly` and
> should run its dashboard on `KELLY_PORT` (7338). Kelly is Codex-only, so skip the
> Claude provider steps, and its profile never loads Gmail, jobs, meetings,
> screenshots, social posting, mailwatch, launch, or standups. Kelly's product
> guide is [KELLY_README.md](KELLY_README.md).

Two ways through this document.

- **You are an AI coding agent** (Claude Code, Codex CLI, Cursor, …) that
  someone pointed at this repo and said "set this up for me" → start at
  [§1](#1-for-ai-agents-the-runbook). It is a runbook: every step has a
  command, an expected result, and a rule for what to do when it fails.
- **You are a human who wants the ten lines** → jump to
  [§2](#2-human-quick-path). Come back to §1 when something breaks.

Either way, [§3 Troubleshooting](#3-troubleshooting) is the list of things
that actually go wrong here, including the one that eats an afternoon
(iCloud-synced folders).

Setup takes about ten minutes, of which eight are `npm install` and the
first embedding-model download.

---

## 1. For AI agents: the runbook

**You are an AI coding agent setting this repo up for your user.** Work
through the steps in order. Run each command yourself, check it against
the "Expect" line, and do not continue past a failure — diagnose it or
report it. Ask your user only for the steps marked **ASK** (they are
decisions or interactive logins, not things you can decide or complete on
their behalf).

Three standing rules for the whole runbook:

1. **Never print a secret.** Tokens, keys and passwords go into `.env` or
   into the user's terminal, never into your transcript, never into a
   commit, never into a summary.
2. **Never commit `.env`, `soul.md`, `personality.md`, `data/`,
   `memory/`, or `knowledge/`.** They are gitignored for a reason: they
   are the operator's life, not the framework.
3. **You cannot complete an OAuth login.** Provider auth (step 5) happens
   in a browser, from your user's own terminal. Hand them the exact
   command and wait.

### Discovery gate — What problem is this agent solving?

Before selecting modules or changing code, **ASK the user for the problem
statement in their own words**. Establish the users and roles, current workflow,
repeated manual work, source-of-truth data, expected output, success measures,
required surfaces, privacy constraints, and which actions require approval.

Research the use case before recommending a workflow. Inspect local material
first; use available web research and connected tools for current, specialised,
regulated, or integration-dependent facts. Prefer primary sources, cite material
claims, and state uncertainty.

Present a short use-case blueprint covering the current and proposed workflows,
data and RAG boundaries, deterministic services, model responsibilities,
connectors, approval gates, minimum useful release, deferred capabilities, tests,
and success measures. Explain why every recommended module is needed and ask the
user to correct the blueprint before implementation. Do not install every module
merely because the framework contains it.

### Step 0 — Where is the repo?

```bash
pwd
```

**Expect:** a path that is **not** inside an iCloud-, Dropbox-, or
OneDrive-synced folder. On macOS that means: not under `~/Desktop`,
`~/Documents`, or anything containing `Library/Mobile Documents`, unless
the user has iCloud Drive's "Desktop & Documents Folders" switched off.

**If it is synced:** stop and ask the user to move the clone somewhere
local (`~/dev/henry` and `~/Downloads/henry` are both fine), then start
again. This is not a style preference. iCloud evicts files inside
`node_modules` to save disk, and when `tsc` or `node` then reads a
dataless file the syscall blocks forever — the build does not fail, it
hangs, with no error to search for. A previous copy of this repo died
exactly this way.

### Step 0b — Which repo is this? (public framework, or somebody's private mirror)

This matters more than it sounds, and it changes several later steps.

```bash
test -f soul.md && echo "PRIVATE MIRROR — a configured Henry" || echo "PUBLIC FRAMEWORK — a fresh Henry"
```

**Public framework** (`henry-digital-personality-of-luvish`) — the normal case.
Nothing personal is in it. Continue straight through the steps below.

**Private mirror** (`henry-private`) — a full backup of somebody's *running*
Henry: their `soul.md`, `personality.md`, `context.md`, their memories in
`data/engram.db`, their résumé, job applications, mail drafts and standup
history. It exists so its owner can restore their own machine.

If you were handed this to set up Henry **for a different person**, two things
are true at once and you must act on both:

1. **You are holding someone else's personal data.** Say so to your user
   plainly, and do not read, summarise, or feed those files into any model
   beyond what setup needs. If they only wanted the *software*, the public
   framework repo plus [`BOOTSTRAP.md`](BOOTSTRAP.md) is the right starting
   point and this one is not.
2. **`cp soul.example.md soul.md` in Step 4 will silently do nothing**, because
   those files already exist. Skip the reset below and your user's Henry boots
   up believing it is the original owner — calling them by the wrong name,
   recalling a stranger's memories, and carrying rails written for someone
   else's life.

**The reset — run this before Step 1 when the mirror is for a NEW person:**

```bash
# Identity: replace, never inherit.
rm -f soul.md personality.md context.md
cp soul.example.md soul.md
cp personality.example.md personality.md

# The previous owner's memory, work and history.
rm -rf data memory knowledge/raw knowledge/cards
rm -f resume.md application-profile.md
```

**Verify nothing personal survived:** `grep -ril "<previous owner's name>" . --exclude-dir=node_modules --exclude-dir=.git | head` should come back empty.

Then continue from Step 1 as a fresh install.

**Restoring your OWN machine from the mirror instead?** Keep every file, skip
Step 4, and rebuild only what the mirror deliberately leaves out — see the
"restoring from a private mirror" note in Step 8.

### Step 1 — Prerequisites

```bash
node -v      # v22.x or newer
npm -v
git --version
```

**Expect:** Node 22 or newer. (`better-sqlite3` accepts Node 20 through
26; 22+ is what this repo is developed and tested on.) `git` must be on
PATH — one dependency installs straight from GitHub.

**macOS:** if `npm install` later fails compiling `better-sqlite3`, the
Xcode command line tools are missing → `xcode-select --install`, then
retry. Most machines get a prebuilt binary and never compile anything.

**Linux:** you may need `build-essential` and `python3` for the same
reason.

### Step 2 — Install dependencies

```bash
npm install
```

**Expect:** a clean install, no `ERR!` lines.

**Note:** `engram-memory` (the memory engine) is pinned to an upstream Git
repository, so npm shells out to `git` and needs network access to github.com.
If install stops there, see
[§3](#3-troubleshooting).

### Step 3 — Create `.env`

```bash
cp .env.example .env
```

**Nothing in `.env` is required for Henry to boot.** Every key is either
optional, has a working default, or is generated for you. Here is what
matters, in order:

| Key | Status | Notes |
| --- | --- | --- |
| `HENRY_PROVIDER` | **set this** | `codex` or `claude` — whichever your user actually has. Step 5 decides it. |
| `HENRY_PORT`, `HENRY_HOST` | default `7337` / `127.0.0.1` | Loopback only. Change the port if 7337 is taken. |
| `HENRY_ALLOW_REMOTE_DASHBOARD`, `HENRY_DASHBOARD_TOKEN` | leave off | Remote access is off by design. Both are required together to change that. |
| `HENRY_REQUIRE_OUTBOUND_APPROVAL` | leave `true` | The outbound gate. Do not turn this off during setup. |
| `HENRY_DASH_SECRET` | **auto-generated** | Written into `.env` on first use (mode `0600`) by the dashboard login. Do not hand-write it. |
| `HENRY_TELEGRAM_BOT_TOKEN`, `HENRY_TELEGRAM_CHAT_ID` | OPTIONAL | Phone chat + alerts. Step 8. |
| `HENRY_TELEGRAM_STANDUP_CHAT_ID` | OPTIONAL | Team standups. Discover it later with `henry standup discover`. |
| `HENRY_JOB_PROFILE_PATH`, `HENRY_RESUME_SOURCE_PATH` | OPTIONAL | Only for the jobs/resume pipeline; they point at personal files that are gitignored. |
| `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` | OPTIONAL | Daily tech tweet. All four together or none — a partial set is treated as no keys and tweets stage instead of posting. |
| `OPENAI_API_KEY` | OPTIONAL | Not needed. Embeddings run locally and free (`bge-small-en-v1.5`, on-device). |
| `HENRY_OWNER_EMAIL` | OPTIONAL | Lets Henry recognise the owner's own address. (The legacy `DAD_EMAIL` spelling still works.) |
| `HENRY_PORTFOLIO_DIR`, `HENRY_PORTFOLIO_SITE`, `HENRY_GITHUB_LOGIN` | OPTIONAL | Only for the portfolio module: the local checkout of a separate GitHub Pages repo Henry may edit, its public URL (display only, never fetched), and the GitHub account whose contribution graph the daily stats refresh reads. Nothing is baked in — with `HENRY_PORTFOLIO_DIR` unset Henry's prompt carries no portfolio instructions, and with `HENRY_GITHUB_LOGIN` unset the `portfolio.stats` workflow skips with a reason instead of querying an account. |

**Verify:** `test -f .env && echo ok`

### Step 4 — Persona files

```bash
cp soul.example.md soul.md
cp personality.example.md personality.md
```

`soul.md` is Henry's operating contract — the rails, including the
outbound boundary — and `personality.md` is its voice. Both are
gitignored and both are injected into every prompt.

**If you skip this, Henry still runs**, silently, with an empty soul and
an empty persona block. That is a real downgrade, not a warning you can
ignore: the rails live in that file.

Fill in the bracketed placeholders from what you know about your user, or
follow [`docs/design-your-soul.md`](docs/design-your-soul.md). For the
full guided version — an interview that also picks which modules to
enable — hand your user [`BOOTSTRAP.md`](BOOTSTRAP.md) instead; it is the
long-form sibling of this document.

**ASK your user:** what should Henry call them, and which modules do they
want on? Do not guess a name.

**Verify:** `test -f soul.md && test -f personality.md && echo ok`

### Step 5 — Provider auth (the step that actually matters)

Henry does not call a metered API. It drives a **subscription CLI** —
Claude Code or Codex — and your user may well have only one of them.
Detect what is actually installed:

```bash
claude --version 2>/dev/null || echo "claude: not installed"
codex --version  2>/dev/null || echo "codex: not installed"
```

Then check whether that CLI is logged in. Both of these are read-only and
safe for you to run yourself:

```bash
claude auth status     # → JSON incl. "loggedIn": true
codex login status     # → "Logged in using ChatGPT"
```

**Case A — one is installed and logged in.** Good. Go to "Set the
default" below.

**Case B — installed but logged out.** You cannot do this part. It opens
a browser. **Tell your user to run one of these in their own terminal:**

```bash
claude auth login      # Claude Code — signs in to their Anthropic account
codex login            # Codex — signs in to their ChatGPT account
```

Wait for them to say it is done, then re-run the matching `status`
command above to confirm before continuing.

**Case C — neither is installed. ASK your user which one they have a
subscription for**, and install only that one:

```bash
npm install -g @anthropic-ai/claude-code    # Claude Code  → then: claude auth login
npm install -g @openai/codex                # Codex CLI    → then: codex login
```

If they have neither subscription, stop here and tell them: Henry's brain
is a provider CLI, and there is no free path around it. Everything else
(memory, knowledge indexing, the dashboard) will still install and run.

**Set the default provider** to whichever one they authenticated:

```bash
npm link                    # if you have not yet — see step 6
henry provider claude       # or: henry provider codex
```

**Expect:** `{ "provider": "claude" }` (or `codex`). This writes
`provider` into `data/settings.json`, which takes precedence over
`HENRY_PROVIDER` in `.env` at boot. Set both to the same value so the two
never disagree.

> **If your user has only ONE provider, tell them this.** Henry's runner
> tries the configured provider first and, when a run fails, falls back
> to the *other* one. With only one CLI installed, that fallback attempt
> fails too and the error you see mentions a provider the user has never
> heard of. That is expected behaviour, not a broken install — the real
> failure is always the first one in the log.

### Step 6 — Put `henry` on PATH

```bash
npm link
```

**Verify:**

```bash
which henry     # → a path inside your npm global bin
henry provider  # → {"provider": "codex"} or {"provider": "claude"}
```

`henry` works from any directory: `.env` is loaded relative to the repo
root, not the current directory.

**No `npm link`?** Every command below also works as
`node bin/henry.mjs <command>` from the repo root.

### Step 7 — Smoke test

Run all five. Each one is fast, safe, and read-only except where noted.

```bash
henry status
```
**Expect:** JSON with `"name": "Henry"`, your provider, the dashboard URL
`http://127.0.0.1:7337`, `"approvals": 0`, and a `memory` block. On a
fresh clone `memory.count` is `0`.

```bash
henry knowledge stats
```
**Expect:** JSON counts. `{"count": 0, ...}` on a fresh clone.

```bash
henry knowledge index
```
**Expect:** `{"entries": 0, "skipped": 0, "byDomain": {}}` on a fresh
clone — the corpus lane (`knowledge/raw/`) ships empty. A non-zero
`entries` means it found a corpus. This costs nothing; it uses local
embeddings only.

To prove the embedding pipeline end to end, index one real file:

```bash
henry knowledge add /path/to/some-notes.md --domain project-management
henry knowledge search "something in that file"
```
**Expect:** `{"files": 1, "chunks": N, ...}` then a scored hit. The
**first** run downloads ~30MB of model weights (`bge-small-en-v1.5`);
after that everything on this lane is offline and free. Valid `--domain`
values: `gtm`, `growth-strategy`, `product-management`,
`project-management`, `software-development`, `community`, `sales`,
`careers`, `general`.

```bash
henry dashboard
```
**Expect:** `Henry dashboard: http://127.0.0.1:7337`. Open it, confirm
`/chat` loads, then Ctrl+C. If the port is taken it says so and reuses
the running instance instead of crashing.

```bash
npm run typecheck
```
**Expect:** no output at all. Any output is a type error; fix or report
it before handing back.

Optionally `npm test` for the full suite.

**Finally, one real turn** — this one does spend provider quota, so keep
it short:

```bash
henry ask "say hello and tell me which provider you are"
```
**Expect:** a reply in the voice you set in `personality.md`. If it comes
back saying it is not logged in, go back to step 5.

There is no `henry --help`. Bare `henry` starts the REPL. The full
command list is in [`README.md`](README.md), and an unknown command
prints it.

### Step 8 — Optional extras

Every one of these is **OPTIONAL**. Skip them all and Henry works. Only
set up what your user asks for.

| Extra | Install | What it unlocks |
| --- | --- | --- |
| **Telegram** | Ask the user for a bot token from [@BotFather](https://t.me/BotFather); write `HENRY_TELEGRAM_BOT_TOKEN` and `HENRY_TELEGRAM_CHAT_ID` into `.env` yourself. Verify with `henry telegram test`. | Chat with Henry from a phone, plus alerts and digests. Full steps: [`docs/modules/telegram.md`](docs/modules/telegram.md). |
| **PDF ingestion** | `brew install poppler` (macOS) or your distro's poppler package | Lets `knowledge add` read PDFs. Without `pdftotext` on PATH, PDFs are skipped — the run does not abort. |
| **Local NER scrub** | `brew install ollama`, then `ollama pull llama3.2:3b`, then set `local.ollama.ner: true` in `data/settings.json` | A deeper name-scrub pass that runs on-device instead of costing a metered provider call. Fits an 8GB M1 Air. |
| **Browser automation** | `npx playwright install chromium` | Needed by the jobs pipeline and resume/cover-letter PDF rendering. |
| **Gmail** | Gmail connector enabled in Codex | Inbox reading, drafting, and separately approved sends. |
| **Jobs pipeline** | A real `resume.md` and `application-profile.md` (both gitignored) | Job scout, tailored resume + cover letter, application tracking. |
| **Scheduled work** | `henry schedule daemon`, or `henry schedule install` to generate launchd/cron files | Nightly memory consolidation, inbox polling, digests. Review the generated files before installing them. |

**Restoring your own machine from a private mirror.** The mirror carries your
soul, persona, memories and corpus, but four things are excluded on purpose and
must be rebuilt by hand. Nothing warns you if you forget — Henry simply comes up
quieter than it should:

| Missing | Why it is excluded | Rebuild with |
| --- | --- | --- |
| `.env` | Secrets never go to GitHub, private repo or not | Recreate it (Step 3); the vault key regenerates but old encrypted values will not open without the original |
| `data/knowledge.db` | Exceeds GitHub's 100MB limit | `henry knowledge index` — rebuilds the index from `knowledge/raw`, which IS in the mirror |
| `data/browser-profile/` | Live logged-in browser sessions | `henry jobs login` to sign in again |

Your **memories survive** — `data/engram.db` is in the mirror and is checkpointed
before every sync, so it restores intact. It is only the knowledge *index* that
has to be rebuilt, not the knowledge itself.

**Verify a restore:** `henry memory search "something you know you told it"`
should return real hits, and `henry knowledge stats` should show a non-zero index
after re-running the indexer.

### Step 9 — Hand back

Report to your user, in a few lines:

- which provider is configured, and that it is logged in;
- which optional extras you set up and which you skipped;
- anything still waiting on them (credentials, a resume file, a Telegram
  token, a persona detail you had to leave as a placeholder);
- the dashboard URL and `henry repl` as the way in.

Then stop. Do not start the REPL for them and do not commit anything
unless they asked.

---

## 2. Human quick path

```bash
# 0. clone somewhere NOT synced by iCloud/Dropbox (~/dev/henry is fine)
node -v                                   # need 22+
npm install
cp .env.example .env                      # set HENRY_PROVIDER=codex|claude
cp soul.example.md soul.md && cp personality.example.md personality.md
claude auth status || codex login status  # whichever you have; log in if not
npm link                                  # puts `henry` on PATH
henry provider claude                     # or: henry provider codex
henry status                              # JSON readout = you're up
henry repl                                # chat + dashboard on 127.0.0.1:7337
```

Only one of `claude` / `codex` needed. No provider CLI at all → install
one you have a subscription for: `npm install -g @anthropic-ai/claude-code`
or `npm install -g @openai/codex`.

Optional, later: `brew install poppler` (PDFs), `ollama pull llama3.2:3b`
(local NER), Telegram token in `.env`, `npx playwright install chromium`
(jobs).

---

## 3. Troubleshooting

**The build hangs forever with no error.** The repo is in an
iCloud-synced folder. iCloud evicts `node_modules` files to free disk; a
read of a dataless file blocks in the syscall and never returns, so
`tsc`/`node`/`npm` sit there looking busy. Move the clone out of
`~/Desktop` and `~/Documents` (or anything under `Library/Mobile
Documents`), delete `node_modules`, and `npm install` again. This is the
single most expensive failure in this repo's history — check it first,
always.

**`npm install` fails building `better-sqlite3`.** No prebuilt binary
matched your platform, so it tried to compile. macOS:
`xcode-select --install`, then `rm -rf node_modules && npm install`.
Linux: install `build-essential` and `python3`.

**`npm install` fails on `engram-memory`.** It installs from a pinned GitHub
repository, so npm needs `git` on PATH and network access to github.com. If
the pinned repository is unavailable, installation will fail before Henry
starts. This is an access/network problem rather than a Henry runtime problem.

**`Port 7337 is already in use` / `EADDRINUSE`.** Another Henry (a REPL,
a dashboard, or the schedule daemon) already holds it — they all serve
the same dashboard, so this is usually harmless and Henry says
"(already running — reusing it)". To find it: `lsof -nP -iTCP:7337
-sTCP:LISTEN`. To move: `HENRY_PORT=7400 henry dashboard`.

**Replies come back as "not logged in" / "please run /login".** The
provider session expired. Henry detects this specific case and refuses to
treat it as a real answer. Fix from your own terminal:
`claude auth login` or `codex login`, then re-check with
`claude auth status` / `codex login status`.

**Errors mention a provider you do not have.** Expected with a
single-provider setup: the runner falls back to the other CLI when the
first run fails, and that fallback fails too. The real error is the first
one. See the note in step 5.

**PDFs produce nothing.** `pdftotext` is not installed —
`brew install poppler`. Missing binary means that file is skipped, not
that the run failed.

**`henry: command not found`.** `npm link` was not run, or your npm
global bin is not on PATH. Check with `npm prefix -g` (the executable
lands in `<that>/bin`), or just use `node bin/henry.mjs <command>` from
the repo root.

**Secrets: no keys in git, ever.** `.env`, `soul.md`, `personality.md`,
`data/`, `memory/` and `knowledge/` are gitignored — keep it that way. If
you ever need to hand a key to Henry, write it into `.env` and mode it
`0600`. Never paste one into a commit message, an issue, a doc, or an
agent transcript.
