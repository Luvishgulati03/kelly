import type { DispatchTier } from "../types.ts";

/**
 * Public mode settings: the limits for Kelly's public Explore page (the Explore landing page and
 * the talk, counter and chat conversations a visitor reaches through the tunnel). Every value has
 * a safe default and every key is a `<PREFIX>PUBLIC_*` environment variable (KELLY_PUBLIC_* for
 * the Kelly profile, HENRY_PUBLIC_* for the shared Henry profile), so nothing deployment-specific
 * lives in code.
 */
export interface PublicModeConfig {
  maxMessageChars: number;
  /** Visitor turns kept per visitor (one turn = the visitor's message plus Kelly's reply). */
  maxHistoryTurns: number;
  /** A visitor idle this long is forgotten: history dropped, nothing written anywhere. */
  idleMs: number;
  maxVisitors: number;
  /** Model turns allowed at once across every visitor (the brain is the owner's own CLI). */
  maxConcurrent: number;
  /** Turns allowed to wait for a slot before new ones get the polite busy line. */
  maxQueue: number;
  queueWaitMs: number;
  turnTimeoutMs: number;
  perVisitorPerMinute: number;
  perVisitorPerHour: number;
  perClientPerMinute: number;
  perClientPerHour: number;
  maxAudioBytes: number;
  maxAudioSeconds: number;
  tier: DispatchTier;
  /** Shop name shown to visitors; defaults to the configured shop name. */
  shopName?: string;
  /** Keep the content-free public request log at <dataDir>/logs/public.log. */
  requestLog: boolean;
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/** `<PREFIX>PUBLIC_<name>`, falling back to the other profile's spelling. */
function reader(profileId: "henry" | "kelly", env: NodeJS.ProcessEnv): (name: string) => string | undefined {
  const [first, second] = profileId === "kelly" ? ["KELLY_", "HENRY_"] : ["HENRY_", "KELLY_"];
  return (name) => env[`${first}${name}`] ?? env[`${second}${name}`];
}

/**
 * KELLY_REMOTE_LOGIN=on re-enables the owner and counter login through the tunnel. Off by default:
 * the public link then shows only the Explore page and never a login form.
 */
export function remoteLoginEnabled(profileId: "henry" | "kelly" = "kelly", env: NodeJS.ProcessEnv = process.env): boolean {
  return flag(reader(profileId, env)("REMOTE_LOGIN"), false);
}

export function publicModeConfig(profileId: "henry" | "kelly" = "kelly", env: NodeJS.ProcessEnv = process.env): PublicModeConfig {
  const read = reader(profileId, env);
  const tierValue = read("PUBLIC_TIER");
  const tier: DispatchTier = tierValue === "t0" || tierValue === "t2" ? tierValue : "t1";
  return {
    maxMessageChars: int(read("PUBLIC_MAX_MESSAGE_CHARS"), 1_000, 100, 4_000),
    maxHistoryTurns: int(read("PUBLIC_HISTORY_TURNS"), 20, 1, 50),
    idleMs: int(read("PUBLIC_IDLE_MINUTES"), 15, 1, 240) * 60_000,
    maxVisitors: int(read("PUBLIC_MAX_VISITORS"), 500, 10, 10_000),
    maxConcurrent: int(read("PUBLIC_MAX_CONCURRENT"), 2, 1, 8),
    maxQueue: int(read("PUBLIC_MAX_QUEUE"), 4, 0, 50),
    queueWaitMs: int(read("PUBLIC_QUEUE_WAIT_SECONDS"), 25, 1, 300) * 1000,
    turnTimeoutMs: int(read("PUBLIC_TURN_TIMEOUT_SECONDS"), 120, 10, 600) * 1000,
    perVisitorPerMinute: int(read("PUBLIC_VISITOR_PER_MINUTE"), 6, 1, 120),
    perVisitorPerHour: int(read("PUBLIC_VISITOR_PER_HOUR"), 60, 1, 2_000),
    perClientPerMinute: int(read("PUBLIC_CLIENT_PER_MINUTE"), 12, 1, 240),
    perClientPerHour: int(read("PUBLIC_CLIENT_PER_HOUR"), 120, 1, 5_000),
    maxAudioBytes: int(read("PUBLIC_MAX_AUDIO_BYTES"), 2_000_000, 64_000, 8 * 1024 * 1024),
    maxAudioSeconds: int(read("PUBLIC_MAX_AUDIO_SECONDS"), 30, 3, 120),
    tier,
    shopName: read("PUBLIC_SHOP_NAME")?.trim() || undefined,
    requestLog: flag(read("PUBLIC_REQUEST_LOG"), true),
  };
}
