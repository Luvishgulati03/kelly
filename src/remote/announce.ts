import type { TunnelManager, TunnelStatus, TunnelStatusEvent } from "./tunnel.ts";

/**
 * Startup announcement logic for the tunnel (src/cli.ts's announceTunnel), pulled out here so
 * it is unit-testable with fake timers/deps and never has to spawn a real cloudflared/tailscale
 * process. Cloudflare mode's start() returns before the tunnel is actually up (spawnCloudflared
 * never awaits "Registered tunnel connection"), so a caller that only checks the returned
 * status once sees "not active, no error" and must not report that as a failure — it means
 * "still connecting", and TunnelManager's "status" event (see tunnel.ts) reports the real
 * outcome a moment later.
 */

export const TUNNEL_CONNECT_TIMEOUT_MS = 30_000;

export const TUNNEL_STILL_CONNECTING_MESSAGE =
  "Remote access is still connecting; the link will work once Cloudflare registers the tunnel (check with kelly tunnel status).";

export type TunnelAnnounceLevel = "ok" | "warn" | "info";

export interface TunnelAnnounceLine {
  level: TunnelAnnounceLevel;
  text: string;
}

export interface WaitForTunnelDeps {
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/**
 * Waits for the tunnel's first "status" transition (a real remote.started or remote.failed —
 * see tunnel.ts's record()), or resolves "timeout" after timeoutMs. Always detaches its own
 * listener, so it never leaks into a later watchTunnelTransitions() call on the same manager.
 */
export function waitForFirstTunnelTransition(
  tunnel: TunnelManager,
  timeoutMs: number = TUNNEL_CONNECT_TIMEOUT_MS,
  deps: WaitForTunnelDeps = {},
): Promise<TunnelStatusEvent | "timeout"> {
  const setTimeoutFn = deps.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimeoutFn = deps.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  return new Promise((resolve) => {
    let settled = false;
    const handler = (event: TunnelStatusEvent) => {
      if (settled) return;
      settled = true;
      clearTimeoutFn(timer);
      tunnel.off("status", handler);
      resolve(event);
    };
    tunnel.on("status", handler);
    const timer = setTimeoutFn(() => {
      if (settled) return;
      settled = true;
      tunnel.off("status", handler);
      resolve("timeout");
    }, timeoutMs);
  });
}

/**
 * One or two lines for a fresh connect ("Remote access: <url>") or a later reconnect
 * ("Remote access reconnected: <url>"). The public-link warning only accompanies the first
 * connect — a reconnect is not a new place for the operator to re-read it.
 */
export function connectedLines(status: TunnelStatus, reconnected: boolean): TunnelAnnounceLine[] {
  const lines: TunnelAnnounceLine[] = [
    { level: "ok", text: `Remote access${reconnected ? " reconnected" : ""}: ${status.url ?? ""}` },
  ];
  if (status.public && !reconnected) {
    lines.push({ level: "info", text: "Public link: anyone with the URL can reach the login page. The account password is the only lock." });
  }
  return lines;
}

/** The one line for a failure (initial "did not start") or a later drop ("lost"). */
export function failedLine(reason: string, lost: boolean): TunnelAnnounceLine {
  return { level: "warn", text: lost ? `Remote access lost: ${reason}` : `Remote access did not start: ${reason}` };
}

/**
 * Subscribes for the life of the manager (or until the returned unsubscribe is called) and
 * prints exactly one line per real state change: "Remote access reconnected: <url>" when a
 * dropped tunnel comes back, "Remote access lost: <reason>" when a connected one drops.
 * remote.stopped (a deliberate `kelly tunnel stop` / shutdown) is not a drop and prints nothing.
 * Never prints twice for the same transition — this only reacts to the "status" event, which
 * tunnel.ts's record() already de-duplicates to real transitions, not health-loop ticks.
 */
export function watchTunnelTransitions(
  tunnel: TunnelManager,
  initiallyActive: boolean,
  print: (line: TunnelAnnounceLine) => void,
): () => void {
  let lastActive = initiallyActive;
  const handler = ({ kind, status }: TunnelStatusEvent) => {
    if (kind === "remote.stopped") {
      lastActive = status.active;
      return;
    }
    if (kind === "remote.started" && status.active) {
      if (!lastActive) for (const line of connectedLines(status, true)) print(line);
    } else if (kind === "remote.failed") {
      if (lastActive) print(failedLine(status.lastError ?? "unknown error", true));
    }
    lastActive = status.active;
  };
  tunnel.on("status", handler);
  return () => tunnel.off("status", handler);
}
