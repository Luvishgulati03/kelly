import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * `data/settings.json` is one small shared record (`{"provider":"claude","pmMode":true,...}`)
 * read by the runtime, the dashboard, and the knowledge gate. Sync on purpose: the file is
 * a few hundred bytes and the gate's policy calls are synchronous by contract.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Never throws: a missing, empty, corrupt, or non-object settings file reads as `{}`. */
export function readSettings(settingsPath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    // `"claude"` / `[1,2]` parse fine but are not a settings record.
    return isPlainObject(parsed) ? parsed : {};
  } catch { return {}; }
}

/**
 * READ-MERGE-WRITE, never a bare write: a bare `{provider}` write once wiped every other
 * persisted key (audit 2026-08-09 M2, recorded at runtime.ts:194 — toggling the provider
 * silently disabled PM mode). Nested plain objects merge ONE level deep so patching
 * `{knowledge:{domainToggles:{...}}}` keeps sibling `knowledge.*` keys; callers that own a
 * deeper map (the domain toggles) rebuild that whole map before patching. Returns the merged
 * settings actually written. Mode 0600 — settings can carry operator secrets.
 */
export function updateSettings(settingsPath: string, patch: Record<string, unknown>): Record<string, unknown> {
  const current = readSettings(settingsPath);
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const existing = current[key];
    merged[key] = isPlainObject(value) && isPlainObject(existing) ? { ...existing, ...value } : value;
  }
  mkdirSync(path.dirname(path.resolve(settingsPath)), { recursive: true, mode: 0o700 });
  writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return merged;
}
