import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DispatchTier, ProviderEvent, ProviderName, RunResult } from "../types.ts";
import type { RunOptions } from "../providers/runner.ts";
import { publicReplyText } from "../providers/public-sandbox.ts";

/**
 * One public model turn through Kelly's own ProviderRunner (the owner's Claude Code CLI, or Codex), in the public
 * sandbox (src/providers/public-sandbox.ts). The caller supplies the already-built system and user
 * halves (src/public/prompt.ts); this file owns the spawn options and pulls out the final visible
 * reply. It never touches memory, approvals, conversations, transcripts, sessions or quotes.
 */

export type PublicRunner = { run(prompt: string, options: RunOptions): Promise<RunResult> };

let scratchDirCache: string | undefined;

/**
 * An EMPTY directory outside the repository, created once per process (0700). Public turns run
 * here so the CLI never discovers the repo's AGENTS.md or .codex/config.toml (and its kelly_excel
 * MCP server) by walking up from its cwd, and the working directory holds nothing to read even
 * if a tool ever appeared.
 */
export function publicScratchDir(): string {
  if (scratchDirCache && fs.existsSync(scratchDirCache)) return scratchDirCache;
  scratchDirCache = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-public-"));
  fs.chmodSync(scratchDirCache, 0o700);
  return scratchDirCache;
}

export interface PublicTurnResult {
  reply: string;
  provider: ProviderName;
  durationMs: number;
  /** Milliseconds from spawn to the first visible model text (the runner's measure), when known. */
  firstTextMs?: number | null;
  error?: string;
  limited?: boolean;
}

export async function runPublicModelTurn(
  runner: PublicRunner,
  settings: { tier: DispatchTier; turnTimeoutMs: number; provider?: ProviderName; models?: Partial<Record<ProviderName, string>> },
  prompt: { system: string; user: string },
  options: { cwd?: string; onEvent?: (event: ProviderEvent) => void } = {},
): Promise<PublicTurnResult> {
  const result = await runner.run(prompt.user, {
    publicTurn: { systemPrompt: prompt.system, ...(settings.models ? { models: settings.models } : {}) },
    ...(settings.provider ? { provider: settings.provider } : {}),
    cwd: options.cwd ?? publicScratchDir(),
    tier: settings.tier,
    timeoutMs: settings.turnTimeoutMs,
    role: "public",
    readOnly: true,
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });
  // Only the final message counts. The plain `response` is a fallback solely for a run that
  // produced no structured events at all (it would otherwise include Codex reasoning text).
  const structured = result.events.some((event) => event.parsed);
  const reply = result.error ? "" : structured ? publicReplyText(result.provider, result.events) : result.exitCode === 0 ? result.response : "";
  return {
    reply: reply.trim(),
    provider: result.provider,
    durationMs: result.durationMs,
    firstTextMs: result.firstTextMs ?? null,
    ...(result.error ? { error: result.error } : {}),
    ...(result.limited ? { limited: true } : {}),
  };
}
