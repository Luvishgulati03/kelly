import type { RunResult } from "../types.ts";

/** Shared fail-closed boundary for workflows that consume a provider response as data. */
export function requireProviderResponse(result: RunResult, label: string): string {
  if (result.limited) throw new Error(`${label} failed closed: provider limited${result.error ? ` (${result.error})` : ""}`);
  if (result.error !== undefined) throw new Error(`${label} failed closed: provider error (${result.error || "unknown error"})`);
  if (result.exitCode !== 0) throw new Error(`${label} failed closed: provider exit code ${result.exitCode ?? "null"}`);
  const response = result.response.trim();
  if (!response) throw new Error(`${label} failed closed: empty provider response`);
  return response;
}
