# Module doctrine — the 12 rules

Distilled from the organization's personal-AI-agent buildathon handbook and its module sources
(memory, email-replies, cronjobs modules + starter). Every new Henry capability is audited
against this checklist before merge. Sourced 2026-08-06.

1. **Single entry point.** Every model call funnels through `HenryAgent.run()` (or a ProviderRunner it owns). No service spawns its own parallel LLM path. *"Never create a duplicate brain file."*
2. **Wire in, don't reimplement.** Capabilities import and call the existing brain/memory interfaces with minimal additive diffs — never a parallel feature duplicating what the brain does.
3. **Personality is read live.** Voice/config files (`soul.md`, `personality.md`) are re-read per invocation, never baked in at startup.
4. **Additive-only wiring.** A module touches shared files at ≤3 bounded insertion points (import + hook before + hook after). Never a rewrite.
5. **Deterministic actions run through code.** State changes (scheduling, DB writes, sends) execute via a real, testable CLI/function in the turn — the model never hand-edits state files and never claims success it didn't perform. *"The skill must run the deterministic CLI — never hand-edit JSON."*
6. **Fail-open auxiliaries.** Optional modules (memory recall, knowledge injection, notifications) no-op safely when their dependency is missing. A capability failure never breaks the core reply.
7. **No cross-module coupling.** Modules import only the shared kernel interfaces (config, activity, memory, runner, approvals) — never each other. Each is addable/removable independently.
8. **Auto-start, no orphan processes.** Background loops (tickers, watchers, schedulers) start inside the main long-lived process. "Run this in a second terminal" is a defect.
9. **Permission parity at install.** If a module needs a tool/scope, the install step updates the allowlist/gate in the same change. "Scheduled but silently blocked from executing" is the #1 failure mode to prevent.
10. **Guide-executable install docs.** Each module ships an ordered, step-numbered guide written for an executing agent (exact commands, exact file contents, a done-check per step) — see `docs/modules/`.
11. **Verify before declaring done.** Every install/change ends with a concrete reproducible verification (command or test phrase + expected artifact: DB row, file, notification) — never "should work now."
12. **Clean up scaffolding.** Temporary install artifacts are removed after wiring; only runtime files remain. (Henry's `vendor/` is a deliberate, gitignored reference corpus — the documented exception.)

Henry-specific addendum: **the approval gate outranks everything** — any module capable of
outbound action must stage through the ApprovalStore; a scheduled/automated path may only
execute items already explicitly approved.
