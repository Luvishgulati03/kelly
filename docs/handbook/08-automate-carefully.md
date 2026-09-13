# Stage 8: Troubleshooting

Goal: fix known Henry setup/runtime failures with source-backed remedies only.

## `henry: command not found`

From the repository root, either install the local global link or use the
checked-in entrypoint directly:

```bash
npm link
henry status
# equivalent without linking:
node bin/henry.mjs status
```

## Tests Pass But Henry Cannot Answer

The test suite does not authenticate subscription CLIs. Verify the selected
provider and its login independently:

```bash
henry provider
codex login status
# or: claude auth status
henry ask "Reply with: provider connected"
```

## Provider Auth Expired

Symptom: the provider says it is not logged in, asks for login, or Henry reports
an auth failure instead of treating the text as an answer.

Check:

```bash
codex login status
claude auth status
```

Fix from the user's own terminal:

```bash
codex login
claude auth login
```

Then re-run the matching status command.

## Typecheck Or Node Hangs

Symptom: `npx tsc --noEmit`, `node`, or `npm` appears stuck with no useful error.

Check the path:

```bash
pwd
```

Verified fix from `SETUP.md`: move the clone out of cloud-synced folders such as
`~/Desktop`, `~/Documents`, Dropbox, OneDrive, or `Library/Mobile Documents`.
Then reinstall dependencies in the moved checkout:

```bash
rm -rf node_modules
npm install
npx tsc --noEmit
```

Only run the removal command from the repo root after confirming `pwd`.

## Bad Path Or Missing Dependencies

Check:

```bash
node -v
npm -v
git --version
```

Verified fixes:

```bash
xcode-select --install
npm install
```

On Linux, install `build-essential` and `python3` if `better-sqlite3` needs to
compile. If `engram-memory` fails during install, confirm `git` and GitHub
network access; it is installed from a pinned GitHub repository.

## Browser Profile Locks

Symptom: a browser-backed Henry action reports that the persistent browser
profile is already open, the browser closed, or a singleton/profile lock exists.

Check the configured profile path in `.env` or source defaults:

```bash
rg -n "BROWSER_PROFILE_DIR|browserProfileDir" .env .env.example src/config.ts
```

Verified fix from the browser code path: close the open Henry-controlled browser
window and retry. Henry clears stale Chromium files named `SingletonLock`,
`SingletonCookie`, and `SingletonSocket` before launching a persistent context,
but it should not fight a live browser using the same profile.

## Dashboard Port Already In Use

If port `7337` is occupied, stop the older Henry dashboard/REPL process or pick
a different loopback port in `.env`:

```bash
HENRY_HOST=127.0.0.1
HENRY_PORT=7338
```

Restart Henry after changing `.env`.

## Telegram Or Gmail Is Not Connected

```bash
henry telegram status
henry telegram test
henry gmail inbox --limit 3
```

Telegram reports missing token/chat configuration. Gmail doctor checks local
credentials, token refresh, scopes, and redirect URI without sending mail or
printing secrets. Follow its next-step output, then restart long-lived Henry
processes after changing `.env`.

## Scheduler Installation Fails

```bash
henry schedule status
henry schedule install            # regenerate reviewable files only
```

launchd is macOS-only and user-level. Cron installation preserves unrelated
entries inside a separately marked Henry block. Use the matching
`henry schedule uninstall --launchd|--cron` command before changing strategies.

## Ollama Is Missing Or Misconfigured

Symptom: optional local model helpers return no enrichment.

Check whether Ollama is configured:

```bash
rg -n "local.*ollama|ollama" data/settings.json src/local/ollama.ts
```

Verified behavior: Ollama is optional and fail-open. The default URL is
`http://127.0.0.1:11434`, local NER is opt-in with `local.ollama.ner === true`,
and non-loopback URLs are refused unless `local.ollama.allowRemote` is true.

Verified fix if you intend to use it:

```bash
ollama pull llama3.2:3b
```

Then start the Ollama daemon with your normal local Ollama setup. If it is not
needed, leave it off; Henry should continue without it.

## Embedding Provider Mismatch

Symptom: Henry warns that existing memory vectors were embedded with an older
provider and will not recall well.

Verified fix from `tests/engram.test.ts`:

```bash
henry memory index --fresh
```

This rebuilds the memory index from durable memory source material and advances
the marker after re-embedding.

---

Previous: [Stage 7: Daily Demo Path](07-build-knowledge.md) | Next: [Stage 9: Extend And Review Safely](09-extend-safely.md)
