# Connector architecture

Henry's Codex brain inherits enabled MCP servers and connectors from the normal Codex host configuration. The CLI, IDE extension, and ChatGPT desktop app share MCP configuration on the same host. Adding and authenticating a connector therefore makes its tools available to Henry's main Codex runs without copying credentials into Henry or building a sub-agent.

In Kelly, the same rule covers the project-local `kelly_excel` MCP server registered in `.codex/config.toml`: Kelly's Codex runs call its bounded workbook tools (inspect, read a range, search, save edits to a new copy) directly, and the source workbook is never overwritten.

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
- Parse only Codex's final agent message; tool commentary is not workflow output.
- Validate and persist in application code. Fail closed before advancing cursors.
- Use honest placeholders for absent source metadata when the event itself remains valid.
- Keep a bounded provider envelope as a hung-process safety rail. It is not a polling schedule.
- Record duration, first-event latency, failure class, and connector role in activity logs.
- Never let connector availability weaken outbound approval requirements.

## Adding a connector

1. Add or enable it through Codex (`codex mcp add`, a plugin, or the Codex settings UI).
2. Authenticate it when required and confirm it appears in `codex mcp list` or `/mcp`.
3. Restart long-lived Henry processes so their next Codex child receives the updated host configuration.
4. Ask Henry for a read-only smoke test.
5. For recurring automation, add an explicit connector prompt, output schema, validation tests, and fail-closed cursor behavior.

## Main brain versus skills

The main brain can discover and call newly connected tools on ordinary natural-language requests. No sub-agent skill is required just to read from Google Drive, Gmail, Figma, or another connected service. Add a skill when “use the tool” is insufficient, such as resume-grounded job replies, a finance workbook workflow, or a company-specific publishing process. For high-risk mutations, keep authorization and execution in application code even when the connector can technically perform the action.
