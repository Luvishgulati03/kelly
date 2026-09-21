import path from "node:path";
import type { ChildProcess, spawn as spawnType } from "node:child_process";
import type { ActivityLog } from "../activity.ts";
import type { ActivityKind } from "../types.ts";

/**
 * Kelly's remote-access tunnel. Kelly never changes its bind address and never sets
 * allowRemoteDashboard: the dashboard stays on 127.0.0.1 always. This module only starts
 * and supervises an external tunnel (Tailscale Serve, or Cloudflare Tunnel as a fallback)
 * that terminates on the tablet side and forwards into the loopback dashboard. Process
 * spawning is fully injected (TunnelDeps) so tests never run a real binary.
 */

export type TunnelMode = "off" | "tailscale" | "cloudflare";

export interface TunnelStatus {
  mode: TunnelMode;
  active: boolean;
  url?: string;
  since?: string;
  restarts: number;
  lastError?: string;
  binary?: string;
}

export interface TunnelConfig {
  mode: TunnelMode;
  port: number;
  tailscalePath: string;
  cloudflaredPath: string;
  cloudflareTunnel?: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface TunnelDeps {
  spawn?: typeof spawnType;
  run?: (cmd: string, args: string[]) => Promise<RunResult>;
  which?: (binary: string) => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  hasAdminAccount: () => boolean;
}

const TAILSCALE_HEALTH_INTERVAL_MS = 30_000;
const BACKOFF_INITIAL_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
const STOP_GRACE_MS = 5_000;
const CONSECUTIVE_FAILURE_THRESHOLD = 3;
const MAX_MESSAGE_LEN = 240;
const MAX_BUFFER_LEN = 4_000;

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bounded(message: string): string {
  return message.length > MAX_MESSAGE_LEN ? `${message.slice(0, MAX_MESSAGE_LEN)}...` : message;
}

export class TunnelManager {
  private _active = false;
  private stopped = true;
  private status_: TunnelStatus;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  // tailscale
  private healthLoopPromise?: Promise<void>;

  // cloudflare
  private cfChild?: ChildProcess;
  private cfBuffer = "";
  private cfBackoff = BACKOFF_INITIAL_MS;
  private cfStopping = false;

  constructor(
    private readonly config: TunnelConfig,
    private readonly activity: ActivityLog,
    private readonly deps: TunnelDeps,
  ) {
    this.status_ = { mode: config.mode, active: false, restarts: 0 };
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? (() => Date.now());
  }

  get active(): boolean {
    return this._active;
  }

  status(): TunnelStatus {
    return {
      mode: this.config.mode,
      active: this._active,
      url: this._active ? this.status_.url : undefined,
      since: this._active ? this.status_.since : undefined,
      restarts: this.status_.restarts,
      lastError: this._active ? undefined : this.status_.lastError,
      binary: this.status_.binary,
    };
  }

  async start(): Promise<TunnelStatus> {
    if (this.config.mode === "off") {
      this.stopped = true;
      this._active = false;
      return this.status();
    }
    this.stopped = false;
    const binaryPath = this.config.mode === "tailscale" ? this.config.tailscalePath : this.config.cloudflaredPath;
    this.status_.binary = path.basename(binaryPath);

    if (this.config.mode === "cloudflare" && !this.config.cloudflareTunnel) {
      return this.fail("KELLY_CLOUDFLARE_TUNNEL is not set. A named Cloudflare tunnel is required for cloudflare mode.");
    }
    if (!(await this.which(binaryPath))) {
      return this.fail(`${this.status_.binary} was not found on PATH. Kelly does not install binaries automatically; see docs/modules/remote-access.md.`);
    }
    if (!this.deps.hasAdminAccount()) {
      return this.fail("Create an admin account first: kelly users add <name> --role admin");
    }

    if (this.config.mode === "tailscale") return this.startTailscale();
    return this.startCloudflare();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.config.mode === "tailscale") {
      await this.stopTailscale();
    } else if (this.config.mode === "cloudflare") {
      await this.stopCloudflare();
    }
    await this.healthLoopPromise?.catch(() => undefined);
  }

  // ---------------------------------------------------------------------
  // shared helpers
  // ---------------------------------------------------------------------

  private async which(binaryPath: string): Promise<boolean> {
    if (!this.deps.which) return false;
    try {
      return await this.deps.which(binaryPath);
    } catch {
      return false;
    }
  }

  private async record(kind: ActivityKind, message: string, metadata?: Record<string, unknown>): Promise<void> {
    try {
      await this.activity.record(kind, bounded(message), metadata);
    } catch {
      /* activity logging must never break the tunnel */
    }
  }

  private async fail(reason: string): Promise<TunnelStatus> {
    this._active = false;
    this.status_.lastError = reason;
    await this.record("remote.failed", reason, { mode: this.config.mode, binary: this.status_.binary });
    return this.status();
  }

  // ---------------------------------------------------------------------
  // tailscale
  // ---------------------------------------------------------------------

  private async startTailscale(): Promise<TunnelStatus> {
    if (!this.deps.run) return this.fail("no tunnel command runner configured");
    try {
      await this.deps.run(this.config.tailscalePath, ["serve", "--bg", "--https=443", `http://127.0.0.1:${this.config.port}`]);
    } catch (error) {
      return this.fail(`tailscale serve failed to start: ${errMessage(error)}`);
    }
    const ok = await this.refreshTailscaleUrl();
    if (ok) {
      await this.record("remote.started", "Tailscale tunnel is active", { mode: "tailscale", binary: this.status_.binary });
    } else {
      await this.record("remote.failed", this.status_.lastError ?? "tailscale did not report a reachable URL", { mode: "tailscale", binary: this.status_.binary });
    }
    this.beginTailscaleHealthLoop();
    return this.status();
  }

  /** Re-reads `tailscale status --json` and derives the https URL from Self.DNSName. Returns whether it succeeded. */
  private async refreshTailscaleUrl(): Promise<boolean> {
    if (!this.deps.run) {
      this.status_.lastError = "no tunnel command runner configured";
      return false;
    }
    // NOTE: failure branches below deliberately leave `_active` untouched. Whether a failed
    // check should flip the tunnel inactive is the health loop's call (three in a row), not
    // this function's; only the caller knows how many consecutive failures came before it.
    let result: RunResult;
    try {
      result = await this.deps.run(this.config.tailscalePath, ["status", "--json"]);
    } catch (error) {
      this.status_.lastError = `could not read tailscale status: ${errMessage(error)}`;
      return false;
    }
    if (result.exitCode !== 0) {
      this.status_.lastError = `tailscale status exited ${String(result.exitCode)}`;
      return false;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      this.status_.lastError = "tailscale status did not return valid JSON";
      return false;
    }
    const dnsName = (parsed as { Self?: { DNSName?: unknown } } | null)?.Self?.DNSName;
    if (typeof dnsName !== "string" || !dnsName.trim()) {
      this.status_.lastError = "tailscale status had no Self.DNSName; is tailscale signed in on this Mac?";
      return false;
    }
    this._active = true;
    this.status_.url = `https://${dnsName.replace(/\.$/, "")}`;
    this.status_.since = this.status_.since ?? new Date(this.now()).toISOString();
    this.status_.lastError = undefined;
    return true;
  }

  private beginTailscaleHealthLoop(): void {
    if (this.healthLoopPromise) return;
    this.healthLoopPromise = this.runTailscaleHealthLoop().finally(() => {
      this.healthLoopPromise = undefined;
    });
  }

  private async runTailscaleHealthLoop(): Promise<void> {
    let consecutiveFailures = 0;
    let backoff = BACKOFF_INITIAL_MS;
    while (!this.stopped) {
      const interval = this._active ? TAILSCALE_HEALTH_INTERVAL_MS : backoff;
      await this.sleep(interval);
      if (this.stopped) return;
      const wasActive = this._active;
      const ok = await this.refreshTailscaleUrl();
      if (ok) {
        consecutiveFailures = 0;
        backoff = BACKOFF_INITIAL_MS;
        if (!wasActive) await this.record("remote.started", "Tailscale tunnel reconnected", { mode: "tailscale", binary: this.status_.binary });
        continue;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD && wasActive) {
        this._active = false;
        await this.record("remote.failed", "Tailscale health check failed three times in a row; tunnel marked inactive", { mode: "tailscale", binary: this.status_.binary });
      }
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  }

  private async stopTailscale(): Promise<void> {
    if (this.deps.run) {
      try {
        await this.deps.run(this.config.tailscalePath, ["serve", "--https=443", "off"]);
      } catch {
        /* best effort; the process is going down regardless */
      }
    }
    if (this._active) {
      this._active = false;
      await this.record("remote.stopped", "Tailscale serve turned off", { mode: "tailscale", binary: this.status_.binary });
    }
  }

  // ---------------------------------------------------------------------
  // cloudflare
  // ---------------------------------------------------------------------

  private async startCloudflare(): Promise<TunnelStatus> {
    this.cfBackoff = BACKOFF_INITIAL_MS;
    this.status_.restarts = 0;
    this.spawnCloudflared();
    return this.status();
  }

  private spawnCloudflared(): void {
    if (!this.deps.spawn) {
      this.status_.lastError = "no process spawner configured";
      void this.record("remote.failed", this.status_.lastError, { mode: "cloudflare", binary: this.status_.binary });
      return;
    }
    this.cfBuffer = "";
    let child: ChildProcess;
    try {
      child = this.deps.spawn(this.config.cloudflaredPath, ["tunnel", "run", this.config.cloudflareTunnel ?? ""], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      this.status_.lastError = `could not start cloudflared: ${errMessage(error)}`;
      void this.record("remote.failed", this.status_.lastError, { mode: "cloudflare", binary: this.status_.binary });
      this.scheduleCloudflareRestart();
      return;
    }
    this.cfChild = child;
    child.stdout?.on("data", (chunk: Buffer | string) => this.onCloudflareOutput(String(chunk)));
    child.stderr?.on("data", (chunk: Buffer | string) => this.onCloudflareOutput(String(chunk)));
    child.once("error", (error: Error) => {
      this.status_.lastError = `cloudflared error: ${errMessage(error)}`;
      this.onCloudflareExit(null);
    });
    child.once("close", (code: number | null) => this.onCloudflareExit(code));
  }

  private onCloudflareOutput(chunk: string): void {
    this.cfBuffer = (this.cfBuffer + chunk).slice(-MAX_BUFFER_LEN);
    if (this._active || !this.cfBuffer.includes("Registered tunnel connection")) return;
    this._active = true;
    this.status_.since = new Date(this.now()).toISOString();
    this.status_.lastError = undefined;
    this.cfBackoff = BACKOFF_INITIAL_MS;
    // Hostname only, never the surrounding line: a query string or adjacent token in the
    // same log line must not leak into status/activity metadata.
    const match = this.cfBuffer.match(/https:\/\/[A-Za-z0-9.-]+/);
    this.status_.url = match ? match[0] : undefined;
    void this.record(
      "remote.started",
      this.status_.url ? "Cloudflare tunnel connected" : "Cloudflare tunnel connected (hostname comes from the Cloudflare config)",
      { mode: "cloudflare", binary: this.status_.binary },
    );
  }

  private onCloudflareExit(code: number | null): void {
    this.cfChild = undefined;
    this._active = false;
    if (this.cfStopping) {
      this.cfStopping = false;
      return;
    }
    this.status_.lastError = `cloudflared exited (code ${String(code)}); reconnecting`;
    void this.record("remote.failed", `cloudflared exited unexpectedly (code ${String(code)})`, {
      mode: "cloudflare", binary: this.status_.binary, restarts: this.status_.restarts,
    });
    this.scheduleCloudflareRestart();
  }

  private scheduleCloudflareRestart(): void {
    if (this.stopped) return;
    const wait = this.cfBackoff;
    this.cfBackoff = Math.min(this.cfBackoff * 2, BACKOFF_MAX_MS);
    this.status_.restarts += 1;
    void this.sleep(wait).then(() => {
      if (this.stopped) return;
      this.spawnCloudflared();
    });
  }

  private async stopCloudflare(): Promise<void> {
    this.cfStopping = true;
    this._active = false;
    const child = this.cfChild;
    if (!child) {
      await this.record("remote.stopped", "Cloudflare tunnel stopped", { mode: "cloudflare", binary: this.status_.binary });
      return;
    }
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => {
        child.once("close", () => resolve());
        child.once("exit", () => resolve());
      }),
      this.sleep(STOP_GRACE_MS).then(() => {
        if (this.cfChild === child) child.kill("SIGKILL");
      }),
    ]);
    this.cfChild = undefined;
    await this.record("remote.stopped", "Cloudflare tunnel stopped", { mode: "cloudflare", binary: this.status_.binary });
  }
}
