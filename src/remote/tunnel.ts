import path from "node:path";
import { EventEmitter } from "node:events";
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

export type TunnelMode = "off" | "tailscale" | "cloudflare" | "funnel";

export interface TunnelStatus {
  mode: TunnelMode;
  active: boolean;
  url?: string;
  since?: string;
  restarts: number;
  lastError?: string;
  binary?: string;
  /** "serve"/"funnel" for the tailscale family (tailnet-only vs public); "cloudflare" for cloudflare mode. */
  kind?: "serve" | "funnel" | "cloudflare";
  /** true for funnel mode and cloudflare mode: the link is reachable by anyone, not just tailnet members. */
  public?: boolean;
}

export interface TunnelConfig {
  mode: TunnelMode;
  port: number;
  tailscalePath: string;
  cloudflaredPath: string;
  cloudflareTunnel?: string;
  /** KELLY_PUBLIC_HOST, e.g. "kelly-test.example.com". Cloudflare mode reports this exact
   *  hostname as status().url once cloudflared confirms a registered connection, instead of
   *  scraping the CLI's own log line for a hostname. */
  publicHost?: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** true when the command was killed because it exceeded runTimeoutMs (see TunnelDeps). */
  timedOut?: boolean;
}

export interface TunnelDeps {
  spawn?: typeof spawnType;
  run?: (cmd: string, args: string[]) => Promise<RunResult>;
  which?: (binary: string) => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  hasAdminAccount: () => boolean;
  /**
   * Milliseconds before a tunnel command (tailscale serve/funnel/status, stop) is treated as
   * hung and aborted. Defaults to TUNNEL_RUN_TIMEOUT_MS. Needed because a freshly installed
   * Tailscale.app whose Network Extension is still "activated waiting for user" approval makes
   * every CLI call block forever with no error, and no output.
   */
  runTimeoutMs?: number;
}

const TAILSCALE_HEALTH_INTERVAL_MS = 30_000;
const BACKOFF_INITIAL_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
const STOP_GRACE_MS = 5_000;
const CONSECUTIVE_FAILURE_THRESHOLD = 3;
const MAX_MESSAGE_LEN = 240;
const MAX_BUFFER_LEN = 4_000;
/** Default ceiling for a single tunnel command before it's treated as hung. See TunnelDeps.runTimeoutMs. */
const TUNNEL_RUN_TIMEOUT_MS = 20_000;
/** Grace period between SIGTERM and SIGKILL when a spawned tunnel command times out. */
const RUN_KILL_GRACE_MS = 2_000;

export const TAILSCALE_NOT_RESPONDING_MESSAGE =
  "Tailscale is installed but not responding. Open the Tailscale app, and if macOS asked, approve its network extension in System Settings > General > Login Items & Extensions > Network Extensions (or Privacy & Security), then sign in from the menu-bar icon and start Kelly again.";

/**
 * Fallback location for the Tailscale CLI on macOS when `tailscale` is not on PATH and
 * KELLY_TAILSCALE_PATH was left unset (config.tailscalePath is still the bare default
 * "tailscale" in that case — see runtime.ts). Kelly never installs Tailscale; this only
 * finds the binary the GUI app already ships.
 */
const TAILSCALE_APP_BUNDLE_PATH = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bounded(message: string): string {
  return message.length > MAX_MESSAGE_LEN ? `${message.slice(0, MAX_MESSAGE_LEN)}...` : message;
}

/**
 * Maps common `tailscale serve`/`funnel` stderr/stdout text to a plain-English sentence with
 * the fix, instead of surfacing the CLI's own wording. Returns undefined when nothing known
 * matches, so the caller falls back to a generic exit-code message.
 */
function classifyTailscaleFailure(output: string, kind: "serve" | "funnel"): string | undefined {
  const text = output.toLowerCase();
  if (!text.trim()) return undefined;
  if (text.includes("not logged in") || text.includes("logged out") || text.includes("needs login") || text.includes("stopped state") || text.includes("not running")) {
    return "Tailscale is not signed in on this Mac. Run `tailscale up`, then try again.";
  }
  if (kind === "funnel" && text.includes("funnel") && (text.includes("not enabled") || text.includes("disabled") || text.includes("not available") || text.includes("acl") || text.includes("attribute"))) {
    return "Tailscale Funnel is not enabled for this tailnet or node. In the Tailscale admin console, enable HTTPS certificates (https://login.tailscale.com/admin/dns) and the Funnel node attribute (https://login.tailscale.com/admin/acls), then try again.";
  }
  if (text.includes("https") && (text.includes("not enabled") || text.includes("cert"))) {
    return "HTTPS certificates are not enabled for this tailnet. Enable them in the Tailscale admin console (https://login.tailscale.com/admin/dns), then try again.";
  }
  return undefined;
}

/**
 * Maps common `cloudflared tunnel run` stderr text to a plain-English sentence with the fix,
 * instead of surfacing the CLI's own wording. `hostOrTunnel` (KELLY_PUBLIC_HOST, falling back
 * to the tunnel name) is only used to make the suggested setup command concrete; it never
 * changes which failure was matched. Returns undefined when nothing known matches, so the
 * caller falls back to the generic "cloudflared exited (code N)" message.
 */
function classifyCloudflareFailure(output: string, hostOrTunnel?: string): string | undefined {
  const text = output.toLowerCase();
  if (!text.trim()) return undefined;
  const setupTarget = hostOrTunnel ?? "<hostname>";
  if (text.includes("cannot determine default origin certificate") || text.includes("cert.pem")) {
    return `Cloudflare tunnel is not set up on this Mac yet. Run \`kelly tunnel setup ${setupTarget}\`, then try again.`;
  }
  if (text.includes("tunnel not found") || (text.includes("credentials file") && (text.includes("not found") || text.includes("missing") || text.includes("no such file")))) {
    return `Cloudflare tunnel is not set up on this Mac yet. Run \`kelly tunnel setup ${setupTarget}\`, then try again.`;
  }
  if (text.includes("failed to dial") || text.includes("network is unreachable") || text.includes("no such host") || text.includes("connection refused")) {
    return "Could not reach Cloudflare. Check the internet connection on this Mac; Kelly keeps retrying.";
  }
  return undefined;
}

/**
 * "status" is emitted every time record() logs a remote.started/remote.failed/remote.stopped
 * transition, i.e. every point where status().active or status().lastError actually changed —
 * never on a no-op health-loop tick. Callers (src/remote/announce.ts) use it both to await the
 * very first connect/fail after start() returns "still connecting", and to notice later
 * drop/reconnect transitions for the life of the process.
 */
export interface TunnelStatusEvent {
  kind: ActivityKind;
  status: TunnelStatus;
}

export class TunnelManager extends EventEmitter {
  private _active = false;
  private stopped = true;
  private status_: TunnelStatus;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly runTimeoutMs: number;

  // tailscale / funnel
  private healthLoopPromise?: Promise<void>;
  /** Resolved at start(): either config.tailscalePath as-is, or the app-bundle fallback. */
  private resolvedTailscalePath = "";

  // cloudflare
  private cfChild?: ChildProcess;
  private cfBuffer = "";
  private cfBackoff = BACKOFF_INITIAL_MS;
  private cfStopping = false;
  /** Set by onCloudflareOutput when a known failure phrase appears; read by onCloudflareExit
   *  so the plain-English fix (not the generic "exited (code N)") is what the operator sees. */
  private cfClassifiedError?: string;

  constructor(
    private readonly config: TunnelConfig,
    private readonly activity: ActivityLog,
    private readonly deps: TunnelDeps,
  ) {
    super();
    this.status_ = { mode: config.mode, active: false, restarts: 0 };
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? (() => Date.now());
    this.runTimeoutMs = deps.runTimeoutMs ?? TUNNEL_RUN_TIMEOUT_MS;
  }

  get active(): boolean {
    return this._active;
  }

  status(): TunnelStatus {
    const tailscaleFamily = this.config.mode === "tailscale" || this.config.mode === "funnel";
    return {
      mode: this.config.mode,
      active: this._active,
      url: this._active ? this.status_.url : undefined,
      since: this._active ? this.status_.since : undefined,
      restarts: this.status_.restarts,
      lastError: this._active ? undefined : this.status_.lastError,
      binary: this.status_.binary,
      kind: tailscaleFamily ? (this.config.mode === "funnel" ? "funnel" : "serve") : this.config.mode === "cloudflare" ? "cloudflare" : undefined,
      public: this.config.mode === "funnel" || this.config.mode === "cloudflare" ? true : undefined,
    };
  }

  async start(): Promise<TunnelStatus> {
    if (this.config.mode === "off") {
      this.stopped = true;
      this._active = false;
      return this.status();
    }
    this.stopped = false;
    const tailscaleFamily = this.config.mode === "tailscale" || this.config.mode === "funnel";
    let binaryPath = tailscaleFamily ? this.config.tailscalePath : this.config.cloudflaredPath;
    this.status_.binary = path.basename(binaryPath);

    if (this.config.mode === "cloudflare" && !this.config.cloudflareTunnel) {
      return this.fail("KELLY_CLOUDFLARE_TUNNEL is not set. A named Cloudflare tunnel is required for cloudflare mode.");
    }
    let found = await this.which(binaryPath);
    let triedAppBundle = false;
    if (!found && tailscaleFamily && binaryPath === "tailscale") {
      triedAppBundle = true;
      if (await this.which(TAILSCALE_APP_BUNDLE_PATH)) {
        binaryPath = TAILSCALE_APP_BUNDLE_PATH;
        this.status_.binary = path.basename(binaryPath);
        found = true;
      }
    }
    if (!found) {
      if (tailscaleFamily) {
        return this.fail(`${this.status_.binary} was not found on PATH${triedAppBundle ? ` or at ${TAILSCALE_APP_BUNDLE_PATH}` : ""}. Install Tailscale from https://tailscale.com/download (or \`brew install --cask tailscale\`), sign in, then try again.`);
      }
      return this.fail(`${this.status_.binary} was not found on PATH. Kelly does not install binaries automatically; see docs/modules/remote-access.md.`);
    }
    if (tailscaleFamily) this.resolvedTailscalePath = binaryPath;
    if (!this.deps.hasAdminAccount()) {
      return this.fail("Create an admin account first: kelly users add <name> --role admin");
    }

    if (this.config.mode === "tailscale") return this.startTailscale();
    if (this.config.mode === "funnel") return this.startFunnel();
    return this.startCloudflare();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.config.mode === "tailscale") {
      await this.stopTailscale();
    } else if (this.config.mode === "funnel") {
      await this.stopFunnel();
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

  /**
   * Runs a tailscale/funnel CLI command with a hang guard: this.deps.run when the caller
   * injected one (raced against runTimeoutMs, since deps.run is an opaque promise this cannot
   * kill anything itself on timeout), else a direct this.deps.spawn (which can be killed).
   * Never rejects on a hang; resolves with { timedOut: true } instead, so callers always get
   * a plain status error rather than sitting forever (see TAILSCALE_NOT_RESPONDING_MESSAGE).
   */
  private async execTunnelCommand(cmd: string, args: string[]): Promise<RunResult> {
    if (this.deps.run) return this.runWithTimeout(this.deps.run(cmd, args));
    if (this.deps.spawn) return this.spawnWithTimeout(cmd, args);
    throw new Error("no tunnel command runner configured");
  }

  private runWithTimeout(promise: Promise<RunResult>): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ stdout: "", stderr: "", exitCode: null, timedOut: true });
      }, this.runTimeoutMs);
      timer.unref?.();
      promise.then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error as Error);
        },
      );
    });
  }

  /**
   * Fallback default runner used when the caller only injected `spawn` (not `run`). Unlike
   * runWithTimeout, this one actually owns the child process, so a timeout sends SIGTERM and,
   * if it is still alive after RUN_KILL_GRACE_MS, SIGKILL.
   */
  private spawnWithTimeout(cmd: string, args: string[]): Promise<RunResult> {
    return new Promise((resolve) => {
      let settled = false;
      let child: ChildProcess;
      try {
        child = this.deps.spawn!(cmd, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        resolve({ stdout: "", stderr: errMessage(error), exitCode: null });
        return;
      }
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer | string) => { stdout += String(chunk); });
      child.stderr?.on("data", (chunk: Buffer | string) => { stderr += String(chunk); });
      const finish = (exitCode: number | null, timedOut = false): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode, timedOut });
      };
      child.once("error", () => finish(null));
      child.once("close", (code: number | null) => finish(code));
      const timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* process already gone */
        }
        const killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }, RUN_KILL_GRACE_MS);
        killTimer.unref?.();
        finish(null, true);
      }, this.runTimeoutMs);
      timer.unref?.();
    });
  }

  private async record(kind: ActivityKind, message: string, metadata?: Record<string, unknown>): Promise<void> {
    // Emitted synchronously, before the (possibly slow/failing) activity write, so a listener
    // waiting on the very next transition (src/remote/announce.ts) never blocks on disk I/O.
    this.emit("status", { kind, status: this.status() } satisfies TunnelStatusEvent);
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
    if (!this.deps.run && !this.deps.spawn) return this.fail("no tunnel command runner configured");
    let serveResult: RunResult;
    try {
      serveResult = await this.execTunnelCommand(this.resolvedTailscalePath, ["serve", "--bg", "--https=443", `http://127.0.0.1:${this.config.port}`]);
    } catch (error) {
      return this.fail(`tailscale serve failed to start: ${errMessage(error)}`);
    }
    if (serveResult.timedOut) return this.fail(TAILSCALE_NOT_RESPONDING_MESSAGE);
    const ok = await this.refreshTailscaleUrl();
    if (ok) {
      await this.record("remote.started", "Tailscale tunnel is active", { mode: "tailscale", binary: this.status_.binary });
    } else {
      await this.record("remote.failed", this.status_.lastError ?? "tailscale did not report a reachable URL", { mode: "tailscale", binary: this.status_.binary });
    }
    this.beginTailscaleHealthLoop();
    return this.status();
  }

  /**
   * Runs `tailscale funnel --bg --https=443 http://127.0.0.1:<port>`, mapping the CLI's own
   * stderr/stdout wording to a plain sentence with the fix (funnel-not-enabled, not signed in),
   * then derives the URL exactly like serve mode. Requires an admin account (checked in start())
   * and prints a one-line reminder that the link is public.
   */
  private async startFunnel(): Promise<TunnelStatus> {
    if (!this.deps.run && !this.deps.spawn) return this.fail("no tunnel command runner configured");
    let result: RunResult;
    try {
      result = await this.execTunnelCommand(this.resolvedTailscalePath, ["funnel", "--bg", "--https=443", `http://127.0.0.1:${this.config.port}`]);
    } catch (error) {
      return this.fail(`tailscale funnel failed to start: ${errMessage(error)}`);
    }
    if (result.timedOut) return this.fail(TAILSCALE_NOT_RESPONDING_MESSAGE);
    const known = classifyTailscaleFailure(`${result.stdout}\n${result.stderr}`, "funnel");
    if (known) return this.fail(known);
    if (result.exitCode !== 0) {
      return this.fail(`tailscale funnel exited ${String(result.exitCode)}: ${bounded(result.stderr || result.stdout || "unknown error")}`);
    }
    const ok = await this.refreshTailscaleUrl();
    if (ok) {
      // The public-link warning line lives in src/remote/announce.ts, driven by status().public,
      // so cli.ts prints it exactly once for both funnel and cloudflare (never straight from here
      // — this module never touches stdout; see the file header).
      await this.record("remote.started", "Tailscale Funnel is active (public)", { mode: "funnel", binary: this.status_.binary, public: true });
    } else {
      await this.record("remote.failed", this.status_.lastError ?? "tailscale did not report a reachable URL", { mode: "funnel", binary: this.status_.binary });
    }
    this.beginTailscaleHealthLoop();
    return this.status();
  }

  /** Re-reads `tailscale status --json` and derives the https URL from Self.DNSName. Returns whether it succeeded. */
  private async refreshTailscaleUrl(): Promise<boolean> {
    if (!this.deps.run && !this.deps.spawn) {
      this.status_.lastError = "no tunnel command runner configured";
      return false;
    }
    // NOTE: failure branches below deliberately leave `_active` untouched. Whether a failed
    // check should flip the tunnel inactive is the health loop's call (three in a row), not
    // this function's; only the caller knows how many consecutive failures came before it.
    let result: RunResult;
    try {
      result = await this.execTunnelCommand(this.resolvedTailscalePath || this.config.tailscalePath, ["status", "--json"]);
    } catch (error) {
      this.status_.lastError = `could not read tailscale status: ${errMessage(error)}`;
      return false;
    }
    if (result.timedOut) {
      this.status_.lastError = TAILSCALE_NOT_RESPONDING_MESSAGE;
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
        if (!wasActive) await this.record("remote.started", this.config.mode === "funnel" ? "Tailscale Funnel reconnected" : "Tailscale tunnel reconnected", { mode: this.config.mode, binary: this.status_.binary });
        continue;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD && wasActive) {
        this._active = false;
        await this.record("remote.failed", "Tailscale health check failed three times in a row; tunnel marked inactive", { mode: this.config.mode, binary: this.status_.binary });
      }
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  }

  private async stopTailscale(): Promise<void> {
    if (this.deps.run || this.deps.spawn) {
      try {
        await this.execTunnelCommand(this.resolvedTailscalePath || this.config.tailscalePath, ["serve", "--https=443", "off"]);
      } catch {
        /* best effort; the process is going down regardless */
      }
    }
    if (this._active) {
      this._active = false;
      await this.record("remote.stopped", "Tailscale serve turned off", { mode: "tailscale", binary: this.status_.binary });
    }
  }

  private async stopFunnel(): Promise<void> {
    if (this.deps.run || this.deps.spawn) {
      try {
        await this.execTunnelCommand(this.resolvedTailscalePath || this.config.tailscalePath, ["funnel", "--https=443", "off"]);
      } catch {
        /* best effort; the process is going down regardless */
      }
    }
    if (this._active) {
      this._active = false;
      await this.record("remote.stopped", "Tailscale Funnel turned off", { mode: "funnel", binary: this.status_.binary });
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
    this.cfClassifiedError = undefined;
    let child: ChildProcess;
    try {
      // --no-autoupdate is a `tunnel` flag, not a `run` flag, so it sits before `run`.
      // --url means cloudflared needs no ~/.cloudflared/config.yml ingress at all; the named
      // tunnel (created by `kelly tunnel setup`) already owns the DNS route to this hostname.
      child = this.deps.spawn(this.config.cloudflaredPath, [
        "tunnel",
        "--no-autoupdate",
        "run",
        "--url",
        `http://127.0.0.1:${this.config.port}`,
        this.config.cloudflareTunnel ?? "",
      ], {
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
    if (!this.cfClassifiedError) {
      const known = classifyCloudflareFailure(this.cfBuffer, this.config.publicHost ?? this.config.cloudflareTunnel);
      if (known) this.cfClassifiedError = known;
    }
    if (this._active || !this.cfBuffer.includes("Registered tunnel connection")) return;
    this._active = true;
    this.status_.since = new Date(this.now()).toISOString();
    this.status_.lastError = undefined;
    this.cfBackoff = BACKOFF_INITIAL_MS;
    this.cfClassifiedError = undefined;
    // Prefer the operator-declared public hostname (KELLY_PUBLIC_HOST) so the dashboard and the
    // trusted-origin check agree on the exact domain, e.g. https://kelly-test.example.com,
    // instead of whatever hostname happens to be in the log line (a *.trycloudflare.com quick
    // tunnel has none of its own). Falls back to scraping the log line when publicHost is unset.
    if (this.config.publicHost) {
      this.status_.url = `https://${this.config.publicHost}`;
    } else {
      // Hostname only, never the surrounding line: a query string or adjacent token in the
      // same log line must not leak into status/activity metadata.
      const match = this.cfBuffer.match(/https:\/\/[A-Za-z0-9.-]+/);
      this.status_.url = match ? match[0] : undefined;
    }
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
    // A known failure phrase (missing cert, missing tunnel, network) explains itself better
    // than a bare exit code; fall back to the generic message when nothing matched.
    const classified = this.cfClassifiedError;
    this.status_.lastError = classified ?? `cloudflared exited (code ${String(code)}); reconnecting`;
    void this.record("remote.failed", classified ?? `cloudflared exited unexpectedly (code ${String(code)})`, {
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
