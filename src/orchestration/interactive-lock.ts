import fs from "node:fs";
import path from "node:path";
import type { HenryConfig } from "../config.ts";

/**
 * Cross-process courtesy lock: while Luvish is mid-conversation on an interactive
 * surface (repl / web-chat / dashboard ask), background provider runs (standup scans,
 * mailwatch checks) YIELD instead of spawning a second CLI that starves the live turn —
 * the 2026-08-08 "hi took 100s" lesson on this 8GB machine. Purely advisory and
 * bounded: background work waits a little, then proceeds regardless (a stuck
 * conversation must never stall the pipelines forever). Same-process runs are never
 * counted as contention — the in-process admission controller owns that.
 */

const HEARTBEAT_MS = 10_000;
/** A heartbeat older than this is a crashed/finished conversation, not contention. */
export const INTERACTIVE_STALE_MS = 30_000;

function lockFile(config: HenryConfig): string {
  return path.join(config.dataDir, "interactive.lock");
}

/** Marks an interactive turn in flight; returns the release function (idempotent). */
export function holdInteractiveLock(config: HenryConfig): () => void {
  const file = lockFile(config);
  const write = () => {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, `${process.pid}:${Date.now()}`, { encoding: "utf8", mode: 0o600 });
    } catch { /* advisory — never break the turn over the lock */ }
  };
  write();
  const beat = setInterval(write, HEARTBEAT_MS);
  beat.unref?.();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(beat);
    try {
      if (fs.readFileSync(file, "utf8").startsWith(`${process.pid}:`)) fs.rmSync(file, { force: true });
    } catch { /* someone else owns it now — leave it */ }
  };
}

/** True when ANOTHER process has a fresh interactive heartbeat. */
export function interactiveBusy(config: HenryConfig, now: number = Date.now()): boolean {
  try {
    const [pidText, atText] = fs.readFileSync(lockFile(config), "utf8").split(":");
    const pid = Number(pidText);
    const at = Number(atText);
    if (!Number.isFinite(at) || now - at > INTERACTIVE_STALE_MS) return false;
    return !(Number.isFinite(pid) && pid === process.pid);
  } catch {
    return false;
  }
}

/**
 * Bounded wait for the conversation to finish. Returns true when idle was reached,
 * false when the wait budget ran out (caller proceeds anyway — bounded courtesy).
 */
export async function waitForInteractiveIdle(config: HenryConfig, maxWaitMs = 45_000, pollMs = 3_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (!interactiveBusy(config)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return !interactiveBusy(config);
}
