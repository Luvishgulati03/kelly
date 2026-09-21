import { test } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TunnelManager, type TunnelConfig, type TunnelDeps } from "../src/remote/tunnel.ts";
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
