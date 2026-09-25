import type { ProviderEvent, ProviderName } from "../types.ts";
import { PUBLIC_TURN_ENV } from "../guardrails.ts";

/**
 * THE PUBLIC SANDBOX: how a turn answering an anonymous visitor on Kelly's Explore page
 * (src/public/) is spawned.
 *
 * A public turn must not be able to read ANY file, run anything, reach a connector or MCP server
 * (including the project-local kelly_excel server), browse, or keep a session, whatever the
 * visitor types ("cat ~/.env", "read the catalogue database", "export a quote"). The server does
 * the catalogue lookup and every price/GST calculation in code (src/public/catalogue.ts) and
 * inlines the results into the prompt; the model only phrases the answer. Each CLI is locked
 * down with its own documented flags, and both run in an empty 0700 scratch directory outside
 * the repository (src/public/turn.ts), so neither discovers AGENTS.md, CLAUDE.md or
 * .codex/config.toml by walking up from its cwd.
 *
 * Codex (Kelly's provider; flags checked against codex-cli 0.153 `codex exec --help` and
 * `codex features list`):
 *   --disable shell_tool / unified_exec / shell_snapshot   no shell, so no way to read a file
 *   --disable apps, plugins, remote_plugin, browser_use(+external, +full_cdp_access),
 *     computer_use, in_app_browser, in_app_local_automation, view_image, multi_agent,
 *     image_generation, hooks, memories, goals, tool_suggest, skill_search,
 *     skill_mcp_dependency_install, sleep_tool, workspace_dependencies
 *   --ignore-user-config           $CODEX_HOME/config.toml is not loaded (no MCP servers, no profile)
 *   --ignore-rules                 no execpolicy rules
 *   --sandbox read-only, approval_policy=never, web_search=disabled, project_doc_max_bytes=0
 *   --ephemeral                    no session file
 *
 * Claude (only for the shared Henry profile; the Kelly profile is Codex-only and never reaches
 * this branch — tests/kelly-codex-only.test.ts):
 *   --tools "" · --safe-mode · --strict-mcp-config with an empty --mcp-config ·
 *   --setting-sources "" · --permission-mode dontAsk · --disallowedTools <file/shell/web tools> ·
 *   --disable-slash-commands · --no-session-persistence · --system-prompt (replaces the default
 *   agent prompt, which carries the working directory and platform).
 *
 * Both runs get a MINIMAL environment (publicEnvironment): no KELLY_* / HENRY_* keys, no tokens,
 * just what the CLI needs to find its own subscription login, plus KELLY_PUBLIC_TURN=1 so every
 * approval/send/export path and the CLI itself refuse even if a future CLI release handed the
 * model a shell (src/guardrails.ts).
 *
 * Output-side, publicTurnViolation() discards any answer whose event stream shows a tool call, a
 * Claude init that listed a tool or MCP server, or a Codex item that is not a plain message.
 */

/** Built-in Claude tools denied by name on a public turn, on top of `--tools ""`. */
export const CLAUDE_PUBLIC_DENIED_TOOLS = [
  "Bash", "Read", "Edit", "Write", "NotebookEdit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite",
];

/** Codex feature flags turned off on a public turn (see the header). */
export const CODEX_PUBLIC_DISABLED_FEATURES = [
  "shell_tool", "unified_exec", "shell_snapshot", "apps", "plugins", "remote_plugin", "multi_agent",
  "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use",
  "in_app_browser", "in_app_local_automation", "view_image", "image_generation", "hooks", "memories",
  "goals", "tool_suggest", "skill_search", "skill_mcp_dependency_install", "sleep_tool",
  "workspace_dependencies",
  // Not "code_mode_host": code mode itself is off by default, and disabling its host makes
  // codex 0.153 emit an `error` item on every run, which the fail-closed check below discards.
];

export interface PublicArgsOptions {
  model?: string;
  /** Codex reasoning effort; public turns stay low. */
  effort?: "low" | "medium" | "high";
}

/** Claude argv for a public turn. The user message is the positional prompt right after -p. */
export function publicClaudeArgs(userPrompt: string, systemPrompt: string, options: PublicArgsOptions = {}): string[] {
  return [
    "-p", userPrompt,
    ...(options.model ? ["--model", options.model] : []),
    "--system-prompt", systemPrompt,
    "--safe-mode",
    "--tools", "",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--setting-sources", "",
    "--disable-slash-commands",
    "--permission-mode", "dontAsk",
    "--disallowedTools", CLAUDE_PUBLIC_DENIED_TOOLS.join(","),
    "--no-session-persistence",
    // stream-json so the init event proves, per run, that no tool or MCP server was loaded.
    "--verbose", "--output-format", "stream-json",
  ];
}

/** Codex argv for a public turn. Codex has no separate system channel, so the rules ride in the prompt. */
export function publicCodexArgs(fullPrompt: string, options: PublicArgsOptions = {}): string[] {
  return [
    "exec",
    ...(options.model ? ["-m", options.model] : []),
    "--json", "--ephemeral",
    "--sandbox", "read-only",
    "--ignore-user-config", "--ignore-rules",
    ...CODEX_PUBLIC_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
    "-c", 'approval_policy="never"',
    "-c", 'web_search="disabled"',
    "-c", "project_doc_max_bytes=0",
    "-c", `model_reasoning_effort="${options.effort ?? "low"}"`,
    "-c", 'shell_environment_policy.inherit="none"',
    "-c", `shell_environment_policy.set.${PUBLIC_TURN_ENV}="1"`,
    "--skip-git-repo-check",
    fullPrompt,
  ];
}

/** Environment keys a public-turn child may see: enough for the CLI's own subscription login. */
const PUBLIC_BASE_KEYS = ["PATH", "HOME", "USER", "TMPDIR", "LANG", "LC_ALL", "TERM", "CODEX_HOME"];

export function publicEnvironment(provider: ProviderName, extra: Record<string, string | undefined> = {}, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keys = [...PUBLIC_BASE_KEYS, ...(provider === "codex" ? ["OPENAI_API_KEY", "CODEX_API_KEY"] : ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"])];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) if (source[key] !== undefined) env[key] = source[key];
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value;
  env.CI = "1";
  env[PUBLIC_TURN_ENV] = "1";
  return env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const CODEX_MESSAGE_ITEMS = new Set(["agent_message", "reasoning"]);
const CLAUDE_TOOL_BLOCKS = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);

/**
 * Why a public run's answer must be discarded, or undefined when the event stream is clean. Fails
 * closed: an unfamiliar Codex item type counts as a violation, not as a harmless novelty.
 */
export function publicTurnViolation(provider: ProviderName, events: ProviderEvent[]): string | undefined {
  for (const event of events) {
    const parsed = event.parsed;
    if (!isRecord(parsed)) continue;
    if (provider === "claude") {
      if (parsed.type === "system" && parsed.subtype === "init") {
        const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
        const servers = Array.isArray(parsed.mcp_servers) ? parsed.mcp_servers : [];
        if (tools.length) return `claude loaded tools on a public turn (${tools.slice(0, 5).map(String).join(", ")})`;
        if (servers.length) return "claude loaded an MCP server on a public turn";
      }
      if (parsed.type === "assistant") {
        const content = isRecord(parsed.message) ? parsed.message.content : undefined;
        if (Array.isArray(content) && content.some((block) => isRecord(block) && typeof block.type === "string" && CLAUDE_TOOL_BLOCKS.has(block.type))) {
          return "claude attempted a tool call on a public turn";
        }
      }
      if (parsed.type === "stream_event") {
        const inner = parsed.event;
        const block = isRecord(inner) ? inner.content_block : undefined;
        if (isRecord(block) && typeof block.type === "string" && CLAUDE_TOOL_BLOCKS.has(block.type)) return "claude attempted a tool call on a public turn";
      }
    } else if (parsed.type === "item.started" || parsed.type === "item.updated" || parsed.type === "item.completed") {
      const item = parsed.item;
      const type = isRecord(item) && typeof item.type === "string" ? item.type : "unknown";
      if (!CODEX_MESSAGE_ITEMS.has(type)) return `codex produced a ${type} item on a public turn`;
    }
  }
  return undefined;
}

/** The final visible reply of a public run: Claude's result event, or Codex's last agent message. */
export function publicReplyText(provider: ProviderName, events: ProviderEvent[]): string {
  if (provider === "claude") {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const parsed = events[index]?.parsed;
      if (isRecord(parsed) && parsed.type === "result" && typeof parsed.result === "string") return parsed.result;
    }
    return "";
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const parsed = events[index]?.parsed;
    if (!isRecord(parsed) || parsed.type !== "item.completed") continue;
    const item = parsed.item;
    if (isRecord(item) && item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) return item.text;
  }
  return "";
}
