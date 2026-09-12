import type { ProviderName } from "../types.ts";

// USER is required by claude's keychain-backed auth — without it the CLI reports
// "Not logged in" even with a valid session (bisected 2026-08-07).
const BASE_KEYS = ["PATH", "HOME", "USER", "TMPDIR", "LANG", "LC_ALL", "TERM", "CI", "CODEX_HOME", "GH_HOST", "GH_TOKEN", "GITHUB_TOKEN", "NODE_PATH"];

export function safeEnvironment(provider?: ProviderName, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const keys = [...BASE_KEYS];
  if (provider === "codex") keys.push("OPENAI_API_KEY", "CODEX_API_KEY");
  if (provider === "claude") keys.push("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN");
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) if (process.env[key] !== undefined) env[key] = process.env[key];
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
