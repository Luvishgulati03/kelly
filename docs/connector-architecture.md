# Connector architecture

Henry's and Kelly's brain (the Claude Code CLI as primary, Codex as an optional failover) inherits enabled MCP servers and connectors from the provider CLI's own host configuration. Adding and authenticating a connector therefore makes its tools available to main provider runs without copying credentials into the app or building a sub-agent.

In Kelly, the same rule covers the `kelly_excel` MCP server: Kelly generates a `--mcp-config` file and passes it to each `claude` run, so its bounded workbook tools (inspect, read a range, search, save edits to a new copy) are called directly, and the source workbook is never overwritten. `kelly provider check` verifies the wiring. If the optional Codex failover is enabled, the same server is registered in the project-local `.codex/config.toml`.

## Routing rule

1. Use a matching connector directly when its tool is available.
2. Use local code for deterministic state, validation, approvals, retries, and side effects that must be audited.
3. Use browser automation only when no semantic connector or API exists.
4. Add a skill only when the model needs a repeatable procedure, domain-specific interpretation, or safety policy. A skill does not provide connectivity.
5. Add a dedicated service adapter when a workflow must run without an agent, needs guaranteed low latency, or requires deterministic pagination and retry behavior.

## Reliability contract for automated connector workflows

- Name the required connector in the prompt and forbid accidental shell/browser fallbacks.
- Use read-only provider mode for retrieval and classification.
- Require a JSON schema for machine-consumed output. Never depend on prose delimiters.
- Parse only the provider's final agent message; tool commentary is not workflow output.
- Validate and persist in application code. Fail closed before advancing cursors.
- Use honest placeholders for absent source metadata when the event itself remains valid.
- Keep a bounded provider envelope as a hung-process safety rail. It is not a polling schedule.
- Record duration, first-event latency, failure class, and connector role in activity logs.
- Never let connector availability weaken outbound approval requirements.

## Adding a connector

1. Add or enable it through the provider CLI (`claude mcp add`, or `codex mcp add` for the failover).
2. Authenticate it when required and confirm it appears in `claude mcp list` or `/mcp`.
3. Restart long-lived processes so their next provider child receives the updated host configuration.
4. Ask Henry for a read-only smoke test.
5. For recurring automation, add an explicit connector prompt, output schema, validation tests, and fail-closed cursor behavior.

## Main brain versus skills

The main brain can discover and call newly connected tools on ordinary natural-language requests. No sub-agent skill is required just to read from Google Drive, Gmail, Figma, or another connected service. Add a skill when “use the tool” is insufficient, such as resume-grounded job replies, a finance workbook workflow, or a company-specific publishing process. For high-risk mutations, keep authorization and execution in application code even when the connector can technically perform the action.
