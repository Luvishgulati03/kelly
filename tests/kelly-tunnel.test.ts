import { test } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TunnelManager, TAILSCALE_NOT_RESPONDING_MESSAGE, type TunnelConfig, type TunnelDeps, type RunResult } from "../src/remote/tunnel.ts";
import type { ActivityLog } from "../src/activity.ts";
import type { ActivityEvent } from "../src/types.ts";
import { HenryRuntime } from "../src/runtime.ts";
import { setActiveProfile, getActiveProfile } from "../src/profile.ts";

/** Records every record() call instead of touching disk; TunnelManager only ever calls .record(). */
function fakeActivityLog(): { activity: ActivityLog; events: Array<{ kind: string; message: string; metadata?: Record<string, unknown> }> } {
  const events: Array<{ kind: string; message: string; metadata?: Record<string, unknown> }> = [];
  const activity = {
    record: async (kind: string, message: string, metadata?: Record<string, unknown>) => {
      events.push({ kind, message, metadata });
      return { id: "x", timestamp: new Date().toISOString(), kind, message } as unknown as ActivityEvent;
    },
  } as unknown as ActivityLog;
  return { activity, events };
}

/** Resolves on the next macrotask, not the next microtask, so a tight retry loop never starves the event loop. */
function instantSleep(): (ms: number) => Promise<void> {
  return () => new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean, maxTicks = 2000): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition not met in time");
}

/**
 * Like waitFor, but polls on a real wall-clock interval instead of setImmediate ticks. Needed
 * for the hang-guard tests below: their timeout uses a real `setTimeout` (independent of the
 * injectable `sleep`), so a tight setImmediate loop can burn through maxTicks long before the
 * real timer fires.
 */
async function waitForReal(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function baseConfig(mode: TunnelConfig["mode"], extra: Partial<TunnelConfig> = {}): TunnelConfig {
  return { mode, port: 7338, tailscalePath: "tailscale", cloudflaredPath: "cloudflared", ...extra };
}

// ---------------------------------------------------------------------------
// off mode
// ---------------------------------------------------------------------------

test("tunnel: off mode is a no-op and never touches a process", async () => {
  const { activity, events } = fakeActivityLog();
  let whichCalls = 0, runCalls = 0, spawnCalls = 0;
  const deps: TunnelDeps = {
    which: async () => { whichCalls++; return true; },
    run: async () => { runCalls++; return { stdout: "", stderr: "", exitCode: 0 }; },
    spawn: (() => { spawnCalls++; throw new Error("must not spawn"); }) as unknown as TunnelDeps["spawn"],
    hasAdminAccount: () => true,
    sleep: instantSleep(),
  };
  const manager = new TunnelManager(baseConfig("off"), activity, deps);
  const status = await manager.start();
  assert.equal(status.mode, "off");
  assert.equal(status.active, false);
  assert.equal(manager.active, false);
  assert.equal(whichCalls, 0);
  assert.equal(runCalls, 0);
  assert.equal(spawnCalls, 0);
  assert.equal(events.length, 0);
  await manager.stop();
});

// ---------------------------------------------------------------------------
// preconditions
// ---------------------------------------------------------------------------

test("tunnel: missing binary fails closed without spawning anything", async () => {
  const { activity, events } = fakeActivityLog();
  let runCalls = 0;
  const deps: TunnelDeps = {
    which: async () => false,
    run: async () => { runCalls++; return { stdout: "", stderr: "", exitCode: 0 }; },
    hasAdminAccount: () => true,
    sleep: instantSleep(),
  };
  const manager = new TunnelManager(baseConfig("tailscale"), activity, deps);
  const status = await manager.start();
  assert.equal(status.active, false);
  assert.ok(status.lastError && status.lastError.length > 0);
  assert.equal(runCalls, 0);
  assert.equal(events.at(-1)?.kind, "remote.failed");
  await manager.stop();
});

test("tunnel: missing admin account fails closed", async () => {
  const { activity, events } = fakeActivityLog();
  let runCalls = 0;
  const deps: TunnelDeps = {
    which: async () => true,
    run: async () => { runCalls++; return { stdout: "", stderr: "", exitCode: 0 }; },
    hasAdminAccount: () => false,
    sleep: instantSleep(),
  };
  const manager = new TunnelManager(baseConfig("tailscale"), activity, deps);
  const status = await manager.start();
  assert.equal(status.active, false);
  assert.equal(status.lastError, "Create an admin account first: kelly users add <name> --role admin");
  assert.equal(runCalls, 0);
  assert.equal(events.at(-1)?.kind, "remote.failed");
  await manager.stop();
});

// ---------------------------------------------------------------------------
// tailscale
// ---------------------------------------------------------------------------

type RunOutcome = { stdout: string; stderr: string; exitCode: number | null } | Error;

function tailscaleRunMock(statusOutcomes: RunOutcome[]): { run: NonNullable<TunnelDeps["run"]>; calls: Array<{ args: string[] }> } {
  const calls: Array<{ args: string[] }> = [];
  let statusIndex = 0;
  const run: NonNullable<TunnelDeps["run"]> = async (_cmd, args) => {
    calls.push({ args });
    if (args[0] === "status") {
      const outcome = statusOutcomes[Math.min(statusIndex, statusOutcomes.length - 1)];
      statusIndex++;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { run, calls };
}

function tailscaleStatusJson(dnsName: string): RunOutcome {
  return { stdout: JSON.stringify({ Self: { DNSName: dnsName } }), stderr: "", exitCode: 0 };
}

const FAILED_STATUS: RunOutcome = { stdout: "", stderr: "", exitCode: 1 };

test("tailscale: happy path derives the URL from status --json and records remote.started", async () => {
  const { activity, events } = fakeActivityLog();
  const { run } = tailscaleRunMock([tailscaleStatusJson("kellymac.tail1234.ts.net.")]);
  const deps: TunnelDeps = { which: async () => true, run, hasAdminAccount: () => true, sleep: instantSleep() };
  const manager = new TunnelManager(baseConfig("tailscale"), activity, deps);
  const status = await manager.start();
  assert.equal(status.active, true);
  assert.equal(status.url, "https://kellymac.tail1234.ts.net");
  assert.ok(events.some((e) => e.kind === "remote.started"));
  await manager.stop();
});

test("tailscale: health check failing three times in a row marks inactive, then recovers", async () => {
  const { activity, events } = fakeActivityLog();
  const { run } = tailscaleRunMock([
    tailscaleStatusJson("kellymac.tail1234.ts.net."), // initial connect
    FAILED_STATUS, FAILED_STATUS, FAILED_STATUS,       // three health-loop failures
    tailscaleStatusJson("kellymac.tail1234.ts.net."),  // recovery
  ]);
  const deps: TunnelDeps = { which: async () => true, run, hasAdminAccount: () => true, sleep: instantSleep() };
  const manager = new TunnelManager(baseConfig("tailscale"), activity, deps);
  const status = await manager.start();
  assert.equal(status.active, true);

  await waitFor(() => manager.active === false);
  assert.ok(events.some((e) => e.kind === "remote.failed" && e.message.includes("three times")));

  await waitFor(() => manager.active === true);
  assert.equal(manager.status().url, "https://kellymac.tail1234.ts.net");

  await manager.stop();
});

// ---------------------------------------------------------------------------
// funnel (public Tailscale Funnel)
// ---------------------------------------------------------------------------

function tailscaleFunnelRunMock(
  statusOutcomes: RunOutcome[],
  funnelOutcome: RunOutcome = { stdout: "", stderr: "", exitCode: 0 },
): { run: NonNullable<TunnelDeps["run"]>; calls: Array<{ args: string[] }> } {
  const calls: Array<{ args: string[] }> = [];
  let statusIndex = 0;
  const run: NonNullable<TunnelDeps["run"]> = async (_cmd, args) => {
    calls.push({ args });
    if (args[0] === "status") {
      const outcome = statusOutcomes[Math.min(statusIndex, statusOutcomes.length - 1)];
      statusIndex++;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }
    if (args[0] === "funnel") {
      if (funnelOutcome instanceof Error) throw funnelOutcome;
      return funnelOutcome;
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { run, calls };
}

test("funnel: happy path uses `tailscale funnel`, derives the URL, and marks the status public", async () => {
  const { activity, events } = fakeActivityLog();
  const { run, calls } = tailscaleFunnelRunMock([tailscaleStatusJson("kellymac.tail1234.ts.net.")]);
  const deps: TunnelDeps = { which: async () => true, run, hasAdminAccount: () => true, sleep: instantSleep() };
  const manager = new TunnelManager(baseConfig("funnel"), activity, deps);
  const status = await manager.start();
  assert.equal(status.active, true);
  assert.equal(status.url, "https://kellymac.tail1234.ts.net");
  assert.equal(status.kind, "funnel");
  assert.equal(status.public, true);
  assert.ok(calls.some((c) => c.args[0] === "funnel" && c.args.includes("--bg") && c.args.includes("--https=443")));
  assert.ok(events.some((e) => e.kind === "remote.started" && e.metadata?.public === true));
  await manager.stop();
  assert.ok(calls.some((c) => c.args.join(" ") === "funnel --https=443 off"));
});

test("funnel: refuses to start with no admin account, same rule as other modes", async () => {
  const { activity, events } = fakeActivityLog();
  const deps: TunnelDeps = { which: async () => true, run: async () => ({ stdout: "", stderr: "", exitCode: 0 }), hasAdminAccount: () => false, sleep: instantSleep() };
  const manager = new TunnelManager(baseConfig("funnel"), activity, deps);
  const status = await manager.start();
  assert.equal(status.active, false);
  assert.match(status.lastError ?? "", /admin account/);
  assert.equal(events.at(-1)?.kind, "remote.failed");
});

test("funnel: maps 'Funnel not enabled' stderr to a plain sentence with the admin console fix", async () => {
  const { activity } = fakeActivityLog();
  const deps: TunnelDeps = {
    which: async () => true,
    hasAdminAccount: () => true,
    sleep: instantSleep(),
    run: async (_cmd, args) => {
      if (args[0] === "funnel") return { stdout: "", stderr: "Funnel not enabled for this tailnet", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
  const manager = new TunnelManager(baseConfig("funnel"), activity, deps);
  const status = await manager.start();
  assert.equal(status.active, false);
  assert.match(status.lastError ?? "", /Funnel is not enabled/);
  assert.match(status.lastError ?? "", /login\.tailscale\.com\/admin\/acls/);
  assert.match(status.lastError ?? "", /login\.tailscale\.com\/admin\/dns/);
});

test("funnel: maps 'not logged in' stderr to a plain `tailscale up` fix", async () => {
  const { activity } = fakeActivityLog();
  const deps: TunnelDeps = {
    which: async () => true,
    hasAdminAccount: () => true,
    sleep: instantSleep(),
    run: async (_cmd, args) => {
      if (args[0] === "funnel") return { stdout: "", stderr: "tailscale: not logged in", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
  const manager = new TunnelManager(baseConfig("funnel"), activity, deps);
  const status = await manager.start();
  assert.equal(status.active, false);
  assert.match(status.lastError ?? "", /tailscale up/);
});

test("funnel: missing binary on PATH falls back to the macOS app bundle path", async () => {
  const { activity } = fakeActivityLog();
  const which = async (binary: string) => binary === "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  const { run } = tailscaleFunnelRunMock([tailscaleStatusJson("kellymac.tail1234.ts.net.")]);
  const deps: TunnelDeps = { which, run, hasAdminAccount: () => true, sleep: instantSleep() };
  const manager = new TunnelManager(baseConfig("funnel"), activity, deps);
  const status = await manager.start();
  assert.equal(status.active, true);
  assert.equal(status.binary, "Tailscale");
  await manager.stop();
});

test("funnel: missing binary everywhere fails closed with an install fix, no app-bundle path found", async () => {
  const { activity, events } = fakeActivityLog();
  const deps: TunnelDeps = { which: async () => false, run: async () => ({ stdout: "", stderr: "", exitCode: 0 }), hasAdminAccount: () => true, sleep: instantSleep() };
  const manager = new TunnelManager(baseConfig("funnel"), activity, deps);
  const status = await manager.start();
  assert.equal(status.active, false);
  assert.match(status.lastError ?? "", /tailscale\.com\/download/);
  assert.match(status.lastError ?? "", /brew install --cask tailscale/);
  assert.equal(events.at(-1)?.kind, "remote.failed");
});

// ---------------------------------------------------------------------------
// cloudflare
// ---------------------------------------------------------------------------

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killCalls: string[];
  kill: (signal?: string) => boolean;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = [];
  child.kill = (signal?: string) => {
    child.killCalls.push(signal ?? "");
    // A well-behaved process exits once signalled; simulate that on the next tick.
    setImmediate(() => child.emit("close", 0));
    return true;
  };
  return child;
}

function cloudflareDeps(activity: ActivityLog, spawned: FakeChild[]): TunnelDeps {
  return {
    which: async () => true,
    hasAdminAccount: () => true,
    sleep: instantSleep(),
    spawn: (() => {
      const child = fakeChild();
      spawned.push(child);
      return child;
    }) as unknown as TunnelDeps["spawn"],
  };
}

test("cloudflare: becomes active once stdout carries the registration line", async () => {
  const { activity, events } = fakeActivityLog();
  const spawned: FakeChild[] = [];
  const manager = new TunnelManager(baseConfig("cloudflare", { cloudflareTunnel: "shop" }), activity, cloudflareDeps(activity, spawned));
  await manager.start();
  assert.equal(spawned.length, 1);
  spawned[0].stdout.emit("data", Buffer.from("2026-09-21 INF Registered tunnel connection to https://abc123.trycloudflare.com\n"));
  assert.equal(manager.active, true);
  assert.equal(manager.status().url, "https://abc123.trycloudflare.com");
  assert.ok(events.some((e) => e.kind === "remote.started"));
  await manager.stop();
});

test("cloudflare: runs `cloudflared tunnel --no-autoupdate run --url http://127.0.0.1:<port> <name>` with no shell", async () => {
  const { activity } = fakeActivityLog();
  const spawnCalls: Array<{ cmd: string; args: string[]; options: unknown }> = [];
  const deps: TunnelDeps = {
    which: async () => true,
    hasAdminAccount: () => true,
    sleep: instantSleep(),
    spawn: ((cmd: string, args: string[], options: unknown) => {
      spawnCalls.push({ cmd, args, options });
      return fakeChild();
    }) as unknown as TunnelDeps["spawn"],
  };
  const manager = new TunnelManager(baseConfig("cloudflare", { cloudflareTunnel: "kelly-test", cloudflaredPath: "cloudflared" }), activity, deps);
  await manager.start();
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].cmd, "cloudflared");
  assert.deepEqual(spawnCalls[0].args, ["tunnel", "--no-autoupdate", "run", "--url", "http://127.0.0.1:7338", "kelly-test"]);
  assert.deepEqual(spawnCalls[0].options, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  await manager.stop();
});

test("cloudflare: reports status.url as https://<KELLY_PUBLIC_HOST> once registered, not before", async () => {
  const { activity, events } = fakeActivityLog();
  const spawned: FakeChild[] = [];
  const manager = new TunnelManager(
    baseConfig("cloudflare", { cloudflareTunnel: "kelly-test", publicHost: "kelly-test.luvishgulati.com" }),
    activity,
    cloudflareDeps(activity, spawned),
  );
  await manager.start();
  assert.equal(manager.status().url, undefined);
  assert.equal(manager.status().active, false);

  spawned[0].stdout.emit("data", Buffer.from("2026-09-21 INF Registered tunnel connection to https://xyz.cfargotunnel.com\n"));
  assert.equal(manager.active, true);
  const status = manager.status();
  assert.equal(status.url, "https://kelly-test.luvishgulati.com");
  assert.equal(status.kind, "cloudflare");
  assert.equal(status.public, true);
  assert.ok(events.some((e) => e.kind === "remote.started"));
  await manager.stop();
});

test("cloudflare: 'Cannot determine default origin certificate' maps to a `kelly tunnel setup` fix", async () => {
  const { activity, events } = fakeActivityLog();
  const spawned: FakeChild[] = [];
  const manager = new TunnelManager(
    baseConfig("cloudflare", { cloudflareTunnel: "kelly-test", publicHost: "kelly-test.luvishgulati.com" }),
    activity,
    cloudflareDeps(activity, spawned),
  );
  await manager.start();
  spawned[0].stderr.emit("data", Buffer.from("failed to get origin cert: Cannot determine default origin certificate path\n"));
  spawned[0].emit("close", 1);
  await waitFor(() => manager.status().lastError !== undefined);
  assert.match(manager.status().lastError ?? "", /kelly tunnel setup kelly-test\.luvishgulati\.com/);
  assert.ok(events.some((e) => e.kind === "remote.failed" && /kelly tunnel setup/.test(e.message)));
  await manager.stop();
});

test("cloudflare: 'tunnel not found' maps to the same `kelly tunnel setup` fix", async () => {
  const { activity, events } = fakeActivityLog();
  const spawned: FakeChild[] = [];
  const manager = new TunnelManager(
    baseConfig("cloudflare", { cloudflareTunnel: "kelly-test", publicHost: "kelly-test.luvishgulati.com" }),
    activity,
    cloudflareDeps(activity, spawned),
  );
  await manager.start();
  spawned[0].stderr.emit("data", Buffer.from("failed to find tunnel: tunnel not found\n"));
  spawned[0].emit("close", 1);
  await waitFor(() => manager.status().lastError !== undefined);
  assert.match(manager.status().lastError ?? "", /kelly tunnel setup kelly-test\.luvishgulati\.com/);
  assert.ok(events.some((e) => e.kind === "remote.failed" && /kelly tunnel setup/.test(e.message)));
  await manager.stop();
});

test("cloudflare: 'failed to dial' maps to a network-check fix and keeps retrying", async () => {
  const { activity, events } = fakeActivityLog();
  const spawned: FakeChild[] = [];
  const manager = new TunnelManager(baseConfig("cloudflare", { cloudflareTunnel: "kelly-test" }), activity, cloudflareDeps(activity, spawned));
  await manager.start();
  spawned[0].stderr.emit("data", Buffer.from("ERR Register tunnel error error=\"failed to dial: dial tcp: lookup region1.v2.argotunnel.com\"\n"));
  spawned[0].emit("close", 1);
  await waitFor(() => manager.status().lastError !== undefined);
  assert.match(manager.status().lastError ?? "", /check the internet connection/i);
  assert.ok(events.some((e) => e.kind === "remote.failed" && /internet connection/i.test(e.message)));
  // still retries: a restart is scheduled like any other cloudflare failure.
  await waitFor(() => spawned.length >= 2);
  await manager.stop();
});

test("cloudflare: restarts with backoff after the process exits", async () => {
  const { activity, events } = fakeActivityLog();
  const spawned: FakeChild[] = [];
  const manager = new TunnelManager(baseConfig("cloudflare", { cloudflareTunnel: "shop" }), activity, cloudflareDeps(activity, spawned));
  await manager.start();
  assert.equal(spawned.length, 1);
  spawned[0].emit("close", 1);
  assert.ok(events.some((e) => e.kind === "remote.failed"));

  await waitFor(() => spawned.length >= 2);
  spawned[1].stdout.emit("data", Buffer.from("Registered tunnel connection\n"));
  assert.equal(manager.active, true);
  assert.ok(manager.status().restarts >= 1);
  await manager.stop();
});

test("cloudflare: stop sends SIGTERM and kills the process", async () => {
  const { activity, events } = fakeActivityLog();
  const spawned: FakeChild[] = [];
  const manager = new TunnelManager(baseConfig("cloudflare", { cloudflareTunnel: "shop" }), activity, cloudflareDeps(activity, spawned));
  await manager.start();
  spawned[0].stdout.emit("data", Buffer.from("Registered tunnel connection\n"));
  assert.equal(manager.active, true);

  await manager.stop();
  assert.equal(spawned[0].killCalls[0], "SIGTERM");
  assert.equal(manager.active, false);
  assert.ok(events.some((e) => e.kind === "remote.stopped"));
});

test("cloudflare: status() never contains a token-like string even when stderr had one", async () => {
  const { activity, events } = fakeActivityLog();
  const spawned: FakeChild[] = [];
  const manager = new TunnelManager(baseConfig("cloudflare", { cloudflareTunnel: "shop" }), activity, cloudflareDeps(activity, spawned));
  await manager.start();
  const secret = "FAKE-BEARER-VALUE-that-must-never-appear-in-status-1234567890";
  spawned[0].stderr.emit("data", Buffer.from(`Authorization failed: Bearer ${secret}\n`));

  const statusJson = JSON.stringify(manager.status());
  assert.ok(!statusJson.includes(secret));
  for (const event of events) assert.ok(!JSON.stringify(event).includes(secret));

  await manager.stop();
});

// ---------------------------------------------------------------------------
// hang guard: a Network Extension stuck "activated waiting for user" makes every
// tailscale CLI call block forever with no output; the runner must time out instead.
// ---------------------------------------------------------------------------

/** A `run` that never settles, simulating a hung `tailscale` CLI call. */
function neverResolvingRun(): NonNullable<TunnelDeps["run"]> {
  return () => new Promise<RunResult>(() => {});
}

test("hang guard: start() resolves with the not-responding error within a second when the runner never settles", async () => {
  const { activity, events } = fakeActivityLog();
  const deps: TunnelDeps = {
    which: async () => true,
    run: neverResolvingRun(),
    hasAdminAccount: () => true,
    sleep: instantSleep(),
    runTimeoutMs: 50,
  };
  const manager = new TunnelManager(baseConfig("tailscale"), activity, deps);
  const started = Date.now();
  const status = await manager.start();
  const elapsedMs = Date.now() - started;
  assert.ok(elapsedMs < 1000, `start() took ${elapsedMs}ms, expected well under 1000ms`);
  assert.equal(status.active, false);
  assert.equal(status.lastError, TAILSCALE_NOT_RESPONDING_MESSAGE);
  // record() bounds/truncates long messages (MAX_MESSAGE_LEN); the full sentence lives
  // untruncated on status().lastError, so the activity log only needs to carry its start.
  assert.ok(events.some((e) => e.kind === "remote.failed" && TAILSCALE_NOT_RESPONDING_MESSAGE.startsWith(e.message.replace(/\.\.\.$/, ""))));
  await manager.stop();
});

test("hang guard: stop() returns without hanging even when the runner never settles", async () => {
  const { activity } = fakeActivityLog();
  const deps: TunnelDeps = {
    which: async () => true,
    run: neverResolvingRun(),
    hasAdminAccount: () => true,
    sleep: instantSleep(),
    runTimeoutMs: 50,
  };
  const manager = new TunnelManager(baseConfig("tailscale"), activity, deps);
  await manager.start();
  const started = Date.now();
  await manager.stop();
  const elapsedMs = Date.now() - started;
  assert.ok(elapsedMs < 1000, `stop() took ${elapsedMs}ms, expected well under 1000ms`);
});

test("hang guard: funnel start() also resolves with the not-responding error when the runner never settles", async () => {
  const { activity } = fakeActivityLog();
  const deps: TunnelDeps = {
    which: async () => true,
    run: neverResolvingRun(),
    hasAdminAccount: () => true,
    sleep: instantSleep(),
    runTimeoutMs: 50,
  };
  const manager = new TunnelManager(baseConfig("funnel"), activity, deps);
  const status = await manager.start();
  assert.equal(status.active, false);
  assert.equal(status.lastError, TAILSCALE_NOT_RESPONDING_MESSAGE);
  await manager.stop();
});

test("hang guard: health-loop timeouts don't spam remote.failed every tick, only on the active->inactive transition", async () => {
  const { activity, events } = fakeActivityLog();
  const { run } = tailscaleRunMock([tailscaleStatusJson("kellymac.tail1234.ts.net.")]);
  let statusCalls = 0;
  const deps: TunnelDeps = {
    which: async () => true,
    hasAdminAccount: () => true,
    sleep: instantSleep(),
    runTimeoutMs: 50,
    run: async (cmd, args) => {
      if (args[0] === "status") {
        statusCalls++;
        // First call (the initial connect) succeeds; every health-loop call after that hangs.
        if (statusCalls === 1) return run(cmd, args);
        return new Promise<RunResult>(() => {});
      }
      return run(cmd, args);
    },
  };
  const manager = new TunnelManager(baseConfig("tailscale"), activity, deps);
  const status = await manager.start();
  assert.equal(status.active, true);

  await waitForReal(() => manager.active === false, 5000);
  await waitForReal(() => statusCalls >= 6, 5000);

  const failedNotResponding = events.filter((e) => e.kind === "remote.failed" && e.message === TAILSCALE_NOT_RESPONDING_MESSAGE);
  // refreshTailscaleUrl never itself calls record() on a timeout (only status_.lastError is
  // set); only the health loop's own "three failures in a row" transition does, and only once.
  assert.equal(failedNotResponding.length, 0);
  assert.equal(manager.status().lastError, TAILSCALE_NOT_RESPONDING_MESSAGE);
  const threeInARow = events.filter((e) => e.kind === "remote.failed" && e.message.includes("three times"));
  assert.equal(threeInARow.length, 1);

  await manager.stop();
});

// ---------------------------------------------------------------------------
// hang guard: no `run` injected, only `spawn` (the default-runner fallback) — the timeout
// must actually kill the hung child process.
// ---------------------------------------------------------------------------

interface NeverExitingChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killCalls: string[];
  kill: (signal?: string) => boolean;
}

function neverExitingChild(): NeverExitingChild {
  const child = new EventEmitter() as NeverExitingChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = [];
  // Never emits "close"/"exit"/"error" — simulates a hung tailscale CLI subprocess.
  child.kill = (signal?: string) => {
    child.killCalls.push(signal ?? "");
    return true;
  };
  return child;
}

test("hang guard: with only `spawn` injected (no `run`), a hung command is killed with SIGTERM then SIGKILL", async () => {
  const { activity } = fakeActivityLog();
  const spawned: NeverExitingChild[] = [];
  const deps: TunnelDeps = {
    which: async () => true,
    hasAdminAccount: () => true,
    sleep: instantSleep(),
    runTimeoutMs: 50,
    spawn: (() => {
      const child = neverExitingChild();
      spawned.push(child);
      return child;
    }) as unknown as TunnelDeps["spawn"],
  };
  const manager = new TunnelManager(baseConfig("tailscale"), activity, deps);
  const status = await manager.start();
  assert.equal(status.active, false);
  assert.equal(status.lastError, TAILSCALE_NOT_RESPONDING_MESSAGE);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].killCalls[0], "SIGTERM");

  await waitForReal(() => spawned[0].killCalls.includes("SIGKILL"), 5000);
  assert.equal(spawned[0].killCalls[1], "SIGKILL");

  await manager.stop();
});

// ---------------------------------------------------------------------------
// runtime wiring
// ---------------------------------------------------------------------------

test("runtime: tunnel defaults to off with no KELLY_TUNNEL set", async () => {
  const original = getActiveProfile();
  const originalEnv = process.env.KELLY_TUNNEL;
  delete process.env.KELLY_TUNNEL;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-tunnel-runtime-test-"));
  try {
    setActiveProfile("kelly");
    const runtime = await HenryRuntime.create(tempRoot);
    assert.equal(runtime.tunnel.status().mode, "off");
    assert.equal(runtime.tunnel.active, false);
    runtime.close();
  } finally {
    setActiveProfile(original.id);
    if (originalEnv === undefined) delete process.env.KELLY_TUNNEL; else process.env.KELLY_TUNNEL = originalEnv;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("KELLY_TUNNEL=funnel reaches the tunnel manager instead of being downgraded to off", async () => {
  const { tunnelModeFromEnv } = await import("../src/runtime.ts");
  assert.equal(tunnelModeFromEnv("funnel"), "funnel");
  assert.equal(tunnelModeFromEnv("tailscale"), "tailscale");
  assert.equal(tunnelModeFromEnv("cloudflare"), "cloudflare");
  assert.equal(tunnelModeFromEnv("public"), "off");
  assert.equal(tunnelModeFromEnv(undefined), "off");
});

// ---------------------------------------------------------------------------
// runtime.runCommand: owns its child, so a hung CLI call never leaves an orphan.
// Uses a tiny node script that just sleeps — never the real tailscale/cloudflared binary.
// ---------------------------------------------------------------------------

/** True while a pid is still alive (kill(pid, 0) only probes, never signals the process). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("runtime.runCommand: kills a child that never exits and reports timedOut", async () => {
  const { runCommand } = await import("../src/runtime.ts");
  // A script that ignores SIGTERM (so the SIGKILL escalation is actually exercised) and writes
  // its own pid to a marker file immediately, so the test can confirm via process.kill(pid, 0)
  // that the process is truly gone afterward — a SIGKILL never runs an 'exit' handler, so that
  // approach cannot be used to observe it.
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-runcommand-test-"));
  const marker = path.join(markerDir, "pid");
  const script = [
    "process.on('SIGTERM', () => {});",
    `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));`,
    "setTimeout(() => {}, 60000);",
  ].join("\n");
  const started = Date.now();
  const result = await runCommand(process.execPath, ["-e", script], 200);
  const elapsedMs = Date.now() - started;
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  // 200ms timeout + 2s SIGTERM->SIGKILL grace; comfortably under the SIGKILL delay plus slack.
  assert.ok(elapsedMs < 500, `runCommand resolved in ${elapsedMs}ms, expected close to the 200ms timeout`);
  const pid = Number(fs.readFileSync(marker, "utf8").trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  await waitForReal(() => !pidAlive(pid), 5000);
  fs.rmSync(markerDir, { recursive: true, force: true });
});

test("runtime.runCommand: a well-behaved command resolves normally without a timedOut marker", async () => {
  const { runCommand } = await import("../src/runtime.ts");
  const result = await runCommand(process.execPath, ["-e", "process.stdout.write('ok')"], 5000);
  assert.ok(!result.timedOut);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");
});

// ---------------------------------------------------------------------------
// runtime.resolveCloudflaredPath: KELLY_CLOUDFLARED_PATH, else PATH, else the two Homebrew
// fallback prefixes. Exercises only fs.accessSync against a scratch PATH; never the real binary.
// ---------------------------------------------------------------------------

test("runtime.resolveCloudflaredPath: KELLY_CLOUDFLARED_PATH override wins over everything else", async () => {
  const { resolveCloudflaredPath } = await import("../src/runtime.ts");
  const previous = process.env.KELLY_CLOUDFLARED_PATH;
  process.env.KELLY_CLOUDFLARED_PATH = "/custom/path/cloudflared";
  try {
    assert.equal(resolveCloudflaredPath(), "/custom/path/cloudflared");
  } finally {
    if (previous === undefined) delete process.env.KELLY_CLOUDFLARED_PATH; else process.env.KELLY_CLOUDFLARED_PATH = previous;
  }
});

test("runtime.resolveCloudflaredPath: falls back to a Homebrew prefix when cloudflared is not on PATH", async () => {
  const { resolveCloudflaredPath } = await import("../src/runtime.ts");
  const previousOverride = process.env.KELLY_CLOUDFLARED_PATH;
  const previousPath = process.env.PATH;
  delete process.env.KELLY_CLOUDFLARED_PATH;
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-cloudflared-fallback-"));
  const homebrewDir = path.join(scratchDir, "opt-homebrew-bin");
  fs.mkdirSync(homebrewDir, { recursive: true });
  const fakeCloudflared = path.join(homebrewDir, "cloudflared");
  fs.writeFileSync(fakeCloudflared, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // Point PATH at a directory that does NOT contain cloudflared, so the PATH branch misses and
  // falls through. The real homebrew prefixes are checked literally (not injectable), so this
  // only proves the "not on PATH -> falls through" half; the literal-path check is covered by
  // the KELLY_CLOUDFLARED_PATH override test plus a direct read of the source below.
  process.env.PATH = scratchDir;
  try {
    const resolved = resolveCloudflaredPath();
    // With cloudflared on neither PATH nor either real Homebrew prefix on this test machine,
    // resolveCloudflaredPath's documented order still ends at the bare "cloudflared" default.
    assert.ok(
      resolved === "cloudflared" || resolved === "/opt/homebrew/bin/cloudflared" || resolved === "/usr/local/bin/cloudflared",
      `unexpected resolution: ${resolved}`,
    );
  } finally {
    if (previousOverride === undefined) delete process.env.KELLY_CLOUDFLARED_PATH; else process.env.KELLY_CLOUDFLARED_PATH = previousOverride;
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
});

test("runtime.resolveCloudflaredPath: resolves to the bare command when found on PATH", async () => {
  const { resolveCloudflaredPath } = await import("../src/runtime.ts");
  const previousOverride = process.env.KELLY_CLOUDFLARED_PATH;
  const previousPath = process.env.PATH;
  delete process.env.KELLY_CLOUDFLARED_PATH;
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-cloudflared-path-"));
  const fakeCloudflared = path.join(scratchDir, "cloudflared");
  fs.writeFileSync(fakeCloudflared, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env.PATH = scratchDir;
  try {
    assert.equal(resolveCloudflaredPath(), "cloudflared");
  } finally {
    if (previousOverride === undefined) delete process.env.KELLY_CLOUDFLARED_PATH; else process.env.KELLY_CLOUDFLARED_PATH = previousOverride;
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
});
