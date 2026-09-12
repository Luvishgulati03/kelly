import { statSync } from "node:fs";
import path from "node:path";
import type { RecallResult } from "engram-memory";
import { readSettings, updateSettings } from "../util/settings.ts";
import { KNOWLEDGE_DOMAINS, type KnowledgeBase } from "./store.ts";

/**
 * The knowledge-domain gate: the single place that decides which lanes of the curated
 * corpus a surface may reach.
 *
 * A domain toggle is a real kill switch, not a UI preference: a lane switched off in
 * `data/settings.json` is excluded from EVERY retrieval surface, including Henry's own brain
 * path, and no combination of arguments re-enables it — an explicitly requested lane is a
 * ranking hint at most, and a disabled one is not even that.
 */

export type Audience = "admin" | "personal";

export interface GateOptions {
  /** Who is asking. Both audiences are gated identically today — a toggle binds the admin
   * surface exactly as hard as it binds Henry's own retrieval, which is the point of it. */
  audience: Audience;
  /** Requested lanes — a boost hint, never a hard filter. */
  domains?: string[];
  k?: number;
  /** Usually `config.settingsPath` (data/settings.json). */
  settingsPath: string;
}

export interface DomainPolicyEntry {
  domain: string;
  enabled: boolean;
}

/** Upper bound on a single gated retrieval, so k is not caller-unbounded. */
const MAX_K = 100;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `knowledge.domainToggles` as a domain -> boolean map; anything malformed is ignored (missing key = enabled). */
function domainToggles(settingsPath: string): Record<string, boolean> {
  const knowledge = readSettings(settingsPath).knowledge;
  if (!isPlainObject(knowledge) || !isPlainObject(knowledge.domainToggles)) return {};
  const toggles: Record<string, boolean> = {};
  for (const [domain, value] of Object.entries(knowledge.domainToggles)) {
    if (typeof value === "boolean") toggles[domain] = value;
  }
  return toggles;
}

/**
 * mtime cache for `disabledDomains`. Every gated retrieval asks for the disabled lanes, and
 * that is once per chat turn — re-parsing a settings file that changes a few times a month
 * is pure syscall tax. Keyed by resolved path, stamped with
 * `mtimeMs:size` (size catches an in-place rewrite inside one filesystem tick); a missing
 * file stamps as mtime 0 and caches the empty answer, so the common "no settings yet" case
 * costs one failed stat instead of a failed read + parse.
 */
const disabledCache = new Map<string, { stamp: string; disabled: string[] }>();

function settingsStamp(settingsPath: string): string {
  try {
    const stat = statSync(settingsPath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch { return "0:0"; }
}

/**
 * Domains switched OFF in settings. This is what every retrieval surface — including
 * Luvish's own brain path — passes as `excludeDomains`, so a toggle is a real kill switch
 * rather than a UI preference.
 */
export function disabledDomains(settingsPath: string): string[] {
  const key = path.resolve(settingsPath);
  const stamp = settingsStamp(settingsPath);
  const cached = disabledCache.get(key);
  if (cached && cached.stamp === stamp) return cached.disabled.slice();
  const disabled = Object.entries(domainToggles(settingsPath)).filter(([, enabled]) => !enabled).map(([domain]) => domain);
  disabledCache.set(key, { stamp, disabled });
  return disabled.slice(); // a copy: callers splice it into excludeDomains lists
}

/** Retrieval entry point for every audience-scoped surface (dashboard, gated tools). */
export async function retrieveGated(kb: KnowledgeBase, query: string, opts: GateOptions): Promise<RecallResult[]> {
  const k = Math.min(Math.max(1, Math.trunc(opts.k ?? 8)), MAX_K);
  const requested = (opts.domains ?? []).filter((domain): domain is string => typeof domain === "string" && domain.length > 0);
  const disabled = disabledDomains(opts.settingsPath);

  // Toggles are honored; a requested lane is a ranking hint only (hard request-filters create
  // the blind spots store.recall's domain-boost design avoids). A disabled lane is never
  // boosted and never returned, however loudly the caller asks for it.
  const boost = requested.find((domain) => !disabled.includes(domain));
  return kb.recall(query, { k, domain: boost, excludeDomains: disabled });
}

/** Every knowledge domain with its current on/off state. */
export function domainPolicy(settingsPath: string): DomainPolicyEntry[] {
  const toggles = domainToggles(settingsPath);
  return KNOWLEDGE_DOMAINS.map((domain) => ({
    domain,
    enabled: toggles[domain] !== false, // missing key = enabled
  }));
}

/** Persists one toggle. Throws on an unknown domain so a typo can never silently do nothing. */
export function setDomainEnabled(settingsPath: string, domain: string, enabled: boolean): void {
  if (!(KNOWLEDGE_DOMAINS as readonly string[]).includes(domain)) {
    throw new Error(`Unknown knowledge domain "${domain}". Choose one of: ${KNOWLEDGE_DOMAINS.join(", ")}`);
  }
  // updateSettings merges one level, so the whole toggle map is rebuilt here: sibling
  // toggles, sibling knowledge.* keys, and every other top-level key survive the write.
  const toggles = { ...domainToggles(settingsPath), [domain]: enabled };
  updateSettings(settingsPath, { knowledge: { domainToggles: toggles } });
  // A kill switch must take effect on the very next retrieval, so our own writer drops the
  // mtime cache rather than trusting the clock: two writes inside one filesystem tick would
  // otherwise leave a just-disabled lane live until the next change.
  disabledCache.delete(path.resolve(settingsPath));
}
