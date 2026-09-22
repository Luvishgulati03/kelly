import type { ProviderName } from "../types.ts";
import { getActiveProfile } from "../profile.ts";

// USER is required by claude's keychain-backed auth — without it the CLI reports
// "Not logged in" even with a valid session (bisected 2026-08-07).
const PROFILE_PASSTHROUGH = ["DATA_DIR", "MEMORY_DIR", "KNOWLEDGE_DIR", "TRADE", "SHOP_NAME", "PROVIDER", "PORT"];

const BASE_KEYS = ["PATH", "HOME", "USER", "TMPDIR", "LANG", "LC_ALL", "TERM", "CI", "CODEX_HOME", "GH_HOST", "GH_TOKEN", "GITHUB_TOKEN", "NODE_PATH"];

/**
 * A provider's own shell tool (Codex/Claude) re-invokes this repo's CLI as a fresh process,
 * e.g. `npx tsx src/cli.ts designs search ...` — that grandchild inherits THIS filtered
 * environment, not the running server's raw one. Before AGENT_PROFILE and the active
 * profile's own env-prefixed vars (KELLY_ or HENRY_ — data dir, trade, etc.) were added here,
 * that grandchild silently defaulted back to the "henry" profile and a different (usually empty) data
 * directory than the server it was spawned from — same command, same machine, different
 * store. `src/cli.ts` reads AGENT_PROFILE to activate the right profile; that only helps if
 * the variable actually reaches the process, which is what this allowlist controls.
 */
export function safeEnvironment(provider?: ProviderName, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const keys = [...BASE_KEYS];
  if (provider === "codex") keys.push("OPENAI_API_KEY", "CODEX_API_KEY");
  if (provider === "claude") keys.push("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN");
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) if (process.env[key] !== undefined) env[key] = process.env[key];
  if (process.env.AGENT_PROFILE !== undefined) env.AGENT_PROFILE = process.env.AGENT_PROFILE;
  // Only the location and identity keys cross over. Tokens (dashboard, Telegram, Kokoro)
  // and anything else under the prefix stay with the server: the model's shell must be able
  // to find the same store, not to act as the owner.
  const envPrefix = getActiveProfile().envPrefix;
  for (const suffix of PROFILE_PASSTHROUGH) {
    const key = envPrefix + suffix;
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value;
  return env;
}

export function redactSecrets(value: string): string {
  return value
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, "[REDACTED_API_KEY]")
    .replace(/(gh[pousr]_[A-Za-z0-9_]{20,})/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/(xox[baprs]-[A-Za-z0-9-]{12,})/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED_TOKEN]")
    .replace(/(password|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}
