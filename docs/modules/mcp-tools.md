# Zero-code capabilities: MCP tools via the provider CLIs

**You are Claude Code, Codex, or another coding agent, reading this inside
Henry's repo.** There is no Henry source file to configure here — this
capability comes for free from the provider CLIs Henry already shells out to
(`src/providers/runner.ts`). Your job, if asked to "give Henry access to X,"
is to check whether an MCP server for X already exists before writing a new
`src/integrations/*.ts` module from scratch.

## 1. How it works

Every Henry action ultimately runs as a subprocess of the provider's own CLI:

```
codex exec --json --ephemeral --sandbox <read-only|danger-full-access> -c approval_policy="never" ... <prompt>
claude -p --model <model> <prompt> --dangerously-skip-permissions
```

(see `codexArgs`/`claudeArgs` in `src/providers/runner.ts`). Both CLIs read
their **own**, independent MCP server configuration — not anything Henry's
TypeScript code knows about — the moment they start. So:

- `claude mcp add <name> [-- <command> ...]` (project- or user-scoped) makes
  that server's tools available to **every** subsequent `claude -p` call
  Henry makes, with zero code changes in this repo.
- Connectors enabled in a claude.ai account (Settings → Connectors — Gmail,
  Google Calendar, Google Drive, Notion, Salesforce, Slack, etc.) are also
  available automatically to `claude -p`, because that CLI call authenticates
  as the logged-in account.
- Codex has the equivalent surface: `codex mcp add <name> -- <command> ...`
  (or `--url <URL>` for a hosted HTTP server), confirmed via `codex mcp
  --help` / `codex mcp add --help` on this machine.

Nothing in `src/providers/runner.ts` needs to change — `buildProviderArgs()`
just passes the prompt through; the MCP tool surface is entirely a property
of the CLI's own config (`~/.claude.json` / `.mcp.json` for Claude,
`~/.codex/config.toml` for Codex).

## 2. Three concrete examples

```bash
# Gmail — proven working via Codex's own MCP config, NOT via a claude.ai connector:
# the user's `codex mcp add gmail -- npx @gongrzhe/server-gmail-autoauth-mcp` is
# registered+authenticated, so `codex exec` (Henry's codex provider path) reads the
# real inbox natively. Empirically, a claude.ai Gmail connector does NOT propagate
# into `claude -p` tool calls (verified twice) — `claude -p` has zero Gmail tools
# today; see docs/modules/gmail.md §2 for the read/draft-only hard rule this implies.

# Calendar — via a claude.ai connector (no CLI flag needed):
# claude.ai -> Settings -> Connectors -> enable "Google Calendar"
# any subsequent `claude -p "what's on my calendar tomorrow?"` can use it directly.

# Web search — a stdio MCP server, project-scoped:
claude mcp add web-search -e BRAVE_API_KEY=xxx -- npx -y @modelcontextprotocol/server-brave-search
codex  mcp add web-search --env BRAVE_API_KEY=xxx -- npx -y @modelcontextprotocol/server-brave-search

# Database (read access to Postgres) — a stdio MCP server:
claude mcp add db -- npx -y @modelcontextprotocol/server-postgres "postgresql://user:pass@host/db"
codex  mcp add db -- npx -y @modelcontextprotocol/server-postgres "postgresql://user:pass@host/db"
```

Package names above are illustrative reference servers — check npm/the MCP
server registry for the currently maintained equivalent before installing.
`claude mcp add --transport http <name> <url>` is the shape for a hosted HTTP
MCP server instead of a local stdio one (e.g. `https://mcp.exa.ai/mcp` for
hosted web search); Codex's equivalent is `codex mcp add <name> --url <url>`.

## 3. The caveat that matters most

MCP tools ride the **provider session**, not Henry's approval gate
(`src/guardrails.ts` / `ApprovalStore`). `assertOutboundExecutionClaim()` only
wraps Henry's own hand-written integrations — `GmailService.sendApproved()`,
`JobApplicationService.submitApproved()`, `PullRequestReviewer.postApproved()`.
An MCP tool call happens *inside* the `claude -p`/`codex exec` subprocess,
before any of that TypeScript code runs — Henry's runtime has no visibility
into it and no chance to intercept it.

Two amplifying facts from the actual code:

- Both CLIs run with approval prompts fully disabled
  (`approval_policy="never"` for Codex, `--dangerously-skip-permissions` for
  Claude) — that's deliberate, so Henry's own free-form turns don't stall on
  a human prompt, but it means an outbound-capable MCP tool fires
  immediately, with no confirmation step at all.
- For Claude specifically, `claudeArgs()` in `src/providers/runner.ts` does
  **not** vary its flags when Henry calls it with `readOnly: true` — that
  option only affects Henry's own fallback-sequence logic
  (`ProviderRunner.run()`), it is not passed to the `claude` binary as a
  sandbox restriction. (Codex's `readOnly` does map to a real
  `--sandbox read-only`.) So a write-capable MCP tool connected to Claude is
  write-capable on every Henry call that reaches it, including ones Henry
  labels read-only internally (e.g. `jobs prepare`, `cover generate`,
  `screenshots classify`).

**Rule of thumb**: connect read-only MCP tools freely (calendar lookup, web
search, read-only DB queries). For anything that sends, posts, writes, or
pays — prefer wiring it as a proper Henry module with an `approvalKinds` +
executor pair (see `docs/architecture.md` §2) instead of an MCP tool, so it
goes through `ApprovalStore.claimForExecution()` like gmail/jobs/pr-review do.

## 4. Verify

```bash
claude mcp list      # confirm the server shows as connected, not "⏸ Pending approval"
codex mcp list        # same, for Codex
npx tsx src/cli.ts ask "what MCP tools do you currently have access to?"
# the response should name the tool if the CLI wired it in correctly
```

## 5. Remove

```bash
claude mcp remove <name>
codex mcp remove <name>
```

For a claude.ai connector: disable it in claude.ai → Settings → Connectors —
that revokes access from every future `claude -p` call immediately, no local
config to clean up.
