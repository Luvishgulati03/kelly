import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_READINESS, TunnelManager, pickLoopbackPort, probeReady,
  type ReadinessProbeResult, type TunnelConfig, type TunnelDeps, type TunnelReadinessOptions, type TunnelStatusEvent,
} from "../src/remote/tunnel.ts";
import { resolveCloudflaredPath } from "../src/runtime.ts";
import type { ActivityLog } from "../src/activity.ts";
import { publicHarness } from "./public-harness.ts";

/**
 * Cloudflare readiness, not liveness: a running cloudflared with zero connections (what a Mac's
 * sleep leaves behind) must read as DOWN and be restarted. Two layers:
 *
 *  - deterministic unit tests: a fake child, a scripted /ready, and a hand-driven clock and timer
 *    queue, so the default thresholds (10 s poll, 30 s unhealthy, 30 s wake gap) are exercised
 *    exactly;
 *  - integration tests: a fake `cloudflared` (a small node script written to a temp dir and found
 *    through KELLY_CLOUDFLARED_PATH) that serves /ready on the --metrics address it is given and
 *    can be switched between connected / zero connections / unreachable.
 *
 * No real cloudflared, no real tunnel, no cloudflared default metrics port (20241-20245): every
 * metrics port is an ephemeral loopback port picked at run time.
 */

type Recorded = { kind: string; message: string; metadata?: Record<string, unknown> };

function recorder(): { activity: ActivityLog; events: Recorded[] } {
  const events: Recorded[] = [];
  const activity = {
    record: async (kind: string, message: string, metadata?: Record<string, unknown>) => { events.push({ kind, message, metadata }); return {}; },
  } as unknown as ActivityLog;
  return { activity, events };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${what} not met within ${timeoutMs} ms`);
}

async function ticks(count = 20): Promise<void> {
  for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve));
}

/* ------------------------- deterministic clock ------------------------- */

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
    if (child.killCalls.length === 1) setImmediate(() => child.emit("close", null));
    return true;
  };
  return child;
}

/** A hand-driven clock and timer queue: advance() moves time and fires what is due, in order. */
function fakeClock(start = Date.parse("2026-09-30T08:00:00Z")) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const fireDue = async (): Promise<void> => {
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= now && timers.has(id)) { timers.delete(id); timer.callback(); await ticks(); }
    }
  };
  return {
    now: () => now,
    setTimer: (callback: () => void, ms: number) => { const id = nextId++; timers.set(id, { at: now + ms, callback }); return id; },
    clearTimer: (handle: unknown) => { timers.delete(handle as number); },
    /** Moves time forward in `step` increments, firing due timers and letting promises settle. */
    async advance(ms: number, step = 1_000): Promise<void> {
      const end = now + ms;
      while (now < end) {
        now = Math.min(end, now + step);
        await fireDue();
        await ticks();
      }
    },
    /** Jumps time WITHOUT firing anything in between (the process was frozen), then fires what is due. */
    async sleepAndWake(ms: number): Promise<void> {
      now += ms;
      await fireDue();
      await ticks();
    },
  };
}

function scripted(clock: ReturnType<typeof fakeClock>, initial: ReadinessProbeResult) {
  const spawned: FakeChild[] = [];
  const sleeps: number[] = [];
  const probe = { current: initial, urls: [] as string[] };
  const deps: TunnelDeps = {
    which: async () => true,
    hasAdminAccount: () => true,
    spawn: (() => { const child = fakeChild(); spawned.push(child); return child; }) as unknown as TunnelDeps["spawn"],
    freePort: async () => 45_000 + spawned.length,
    probe: async (url) => { probe.urls.push(url); return probe.current; },
    // The restart backoff: recorded, resolved at once (the clock under test is the poller's).
    sleep: async (ms) => { sleeps.push(ms); await ticks(2); },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  };
  return { spawned, sleeps, probe, deps };
}

const CONNECTED: ReadinessProbeResult = { ready: true, readyConnections: 4 };
const ZERO: ReadinessProbeResult = { ready: false, readyConnections: 0 };
const UNREACHABLE: ReadinessProbeResult = { ready: false, readyConnections: 0, unreachable: true };

function cfConfig(extra: Partial<TunnelConfig> = {}): TunnelConfig {
  return { mode: "cloudflare", port: 7338, tailscalePath: "tailscale", cloudflaredPath: "cloudflared", cloudflareTunnel: "test-tunnel", publicHost: "kelly.example.com", ...extra };
}

function managerWith(deps: TunnelDeps, activity: ActivityLog): { manager: TunnelManager; transitions: TunnelStatusEvent[] } {
  const manager = new TunnelManager(cfConfig(), activity, deps);
  const transitions: TunnelStatusEvent[] = [];
  manager.on("status", (event: TunnelStatusEvent) => transitions.push(event));
  return { manager, transitions };
}

test("readiness: active only after /ready reports connections; zero connections flips it off at the next poll and restarts after 30 s", async () => {
  assert.equal(DEFAULT_READINESS.intervalMs, 10_000);
  assert.equal(DEFAULT_READINESS.unhealthyMs, 30_000);
  const clock = fakeClock();
  const { spawned, sleeps, probe, deps } = scripted(clock, CONNECTED);
  const { activity, events } = recorder();
  const { manager, transitions } = managerWith(deps, activity);
  await manager.start();
  assert.equal(spawned.length, 1);
  assert.equal(manager.status().active, false, "a live process is not a live link");

  await clock.advance(10_000);
  assert.equal(probe.urls[0], "http://127.0.0.1:45000/ready");
  assert.equal(manager.status().active, true);
  assert.equal(manager.status().readyConnections, 4);
  assert.equal(manager.status().lastReadyAt, new Date(clock.now()).toISOString());
  assert.equal(transitions.at(-1)?.kind, "remote.started");

  probe.current = ZERO;
  await clock.advance(10_000);
  assert.equal(manager.status().active, false, "flips false at the first not-ready poll");
  assert.equal(manager.status().readyConnections, 0);
  assert.equal(transitions.at(-1)?.kind, "remote.failed");
  assert.equal(transitions.at(-1)?.reason, "no-connections");
  await clock.advance(20_000);
  assert.equal(spawned.length, 1, "not restarted before 30 s of continuous not-ready");
  await clock.advance(10_000);
  assert.deepEqual(spawned[0].killCalls, ["SIGTERM"], "restarted once 30 s not-ready has elapsed");
  await ticks(40);
  assert.equal(spawned.length, 2);
  assert.deepEqual(sleeps, [5_000], "through the restart backoff");
  assert.equal(manager.status().restarts, 1);

  // Still nothing: the fresh process gets its startup grace, then the backoff doubles.
  await clock.advance(50_000);
  await ticks(40);
  assert.equal(spawned.length, 3);
  assert.deepEqual(sleeps, [5_000, 10_000]);

  probe.current = CONNECTED;
  await clock.advance(10_000);
  assert.equal(manager.status().active, true);
  assert.equal(manager.status().url, "https://kelly.example.com");
  const reconnected = events.filter((event) => event.kind === "remote.started").at(-1);
  assert.equal(reconnected?.message, "Cloudflare tunnel reconnected");
  assert.equal(reconnected?.metadata?.downMs, 90_000, "downtime from the drop at t=20 s to readiness at t=110 s");
  assert.ok(events.some((event) => event.kind === "remote.failed" && event.metadata?.reason === "no-connections"));
  await manager.stop();
});

test("readiness: an unreachable metrics endpoint counts as not ready (reason metrics-unreachable)", async () => {
  const clock = fakeClock();
  const { spawned, probe, deps } = scripted(clock, CONNECTED);
  const { activity } = recorder();
  const { manager, transitions } = managerWith(deps, activity);
  await manager.start();
  await clock.advance(10_000);
  assert.equal(manager.active, true);
  probe.current = UNREACHABLE;
  await clock.advance(10_000);
  assert.equal(manager.active, false);
  assert.equal(manager.status().readyConnections, undefined);
  assert.equal(transitions.at(-1)?.reason, "metrics-unreachable");
  await clock.advance(30_000);
  await ticks(40);
  assert.equal(spawned.length, 2, "restarted, with a freshly picked metrics port");
  assert.notEqual(manager.metricsAddress, "127.0.0.1:45000");
  await manager.stop();
});

test("readiness: a fresh cloudflared gets a startup grace before its first readiness", async () => {
  const clock = fakeClock();
  const { spawned, probe, deps } = scripted(clock, ZERO);
  const { activity } = recorder();
  const { manager, transitions } = managerWith(deps, activity);
  await manager.start();
  await clock.advance(40_000);
  assert.equal(spawned.length, 1, "no restart inside the 45 s startup grace");
  assert.equal(transitions.length, 0, "and no 'lost': it was never up");
  probe.current = CONNECTED;
  await clock.advance(10_000);
  assert.equal(manager.active, true);
  await manager.stop();
});

test("wake from sleep: a poll that fires far later than scheduled restarts cloudflared even if /ready still says connected", async () => {
  const clock = fakeClock();
  const { spawned, sleeps, deps } = scripted(clock, CONNECTED);
  const { activity } = recorder();
  const { manager, transitions } = managerWith(deps, activity);
  await manager.start();
  await clock.advance(10_000);
  assert.equal(manager.active, true);
  // An ordinary late poll (a busy event loop) is not a wake.
  await clock.sleepAndWake(15_000);
  assert.equal(spawned.length, 1);
  assert.equal(manager.active, true);
  // The Mac sleeps for two minutes: the next poll fires ~2 minutes late.
  await clock.sleepAndWake(120_000);
  assert.deepEqual(spawned[0].killCalls, ["SIGTERM"]);
  assert.equal(manager.active, false);
  assert.equal(transitions.at(-1)?.kind, "remote.failed");
  assert.equal(transitions.at(-1)?.reason, "wake-from-sleep");
  await ticks(40);
  assert.equal(spawned.length, 2);
  assert.deepEqual(sleeps, [5_000]);
  await clock.advance(10_000);
  assert.equal(manager.active, true, "reconnected after the restart");
  await manager.stop();
});

test("an exit on its own still restarts with backoff and is reported with reason exited", async () => {
  const clock = fakeClock();
  const { spawned, sleeps, deps } = scripted(clock, CONNECTED);
  const { activity } = recorder();
  const { manager, transitions } = managerWith(deps, activity);
  await manager.start();
  await clock.advance(10_000);
  spawned[0].emit("close", 1);
  await ticks(40);
  assert.equal(transitions.at(-1)?.reason, "exited");
  assert.equal(spawned.length, 2);
  assert.deepEqual(sleeps, [5_000]);
  await manager.stop();
});

test("tailscale modes report no readiness fields", async () => {
  const { activity } = recorder();
  const manager = new TunnelManager(cfConfig({ mode: "tailscale" }), activity, { hasAdminAccount: () => true });
  const status = manager.status();
  assert.equal("readyConnections" in status, false);
  assert.equal("lastReadyAt" in status, false);
});

/* ------------------------- probe + port picker ------------------------- */

test("probeReady: 200 with connections is ready; 503/0 is not; a closed port is unreachable", async () => {
  let reply = { status: 200, body: '{"status":200,"readyConnections":4,"connectorId":"x"}' };
  const server = http.createServer((_request, response) => { response.writeHead(reply.status); response.end(reply.body); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  try {
    assert.deepEqual(await probeReady(`http://127.0.0.1:${port}/ready`, 1_000), { ready: true, readyConnections: 4 });
    reply = { status: 503, body: '{"status":503,"readyConnections":0}' };
    assert.deepEqual(await probeReady(`http://127.0.0.1:${port}/ready`, 1_000), { ready: false, readyConnections: 0 });
    reply = { status: 200, body: '{"status":200,"readyConnections":0}' };
    assert.equal((await probeReady(`http://127.0.0.1:${port}/ready`, 1_000)).ready, false);
    reply = { status: 200, body: "not json" };
    assert.equal((await probeReady(`http://127.0.0.1:${port}/ready`, 1_000)).ready, false);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.deepEqual(await probeReady(`http://127.0.0.1:${port}/ready`, 1_000), { ready: false, readyConnections: 0, unreachable: true });
});

test("pickLoopbackPort: a free loopback port, never one of cloudflared's default metrics ports", async () => {
  for (let i = 0; i < 5; i++) {
    const port = await pickLoopbackPort();
    assert.ok(port > 0 && port < 65_536);
    assert.ok(port < 20_241 || port > 20_245);
  }
});

/* ------------------------- integration: a fake cloudflared binary ------------------------- */

const FAKE_CLOUDFLARED = `
import fs from "node:fs";
import http from "node:http";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CF_LOG, JSON.stringify({ pid: process.pid, args }) + "\\n");
const metrics = args[args.indexOf("--metrics") + 1] || "";
const split = metrics.lastIndexOf(":");
const host = metrics.slice(0, split);
const port = Number(metrics.slice(split + 1));
const mode = () => { try { return fs.readFileSync(process.env.FAKE_CF_STATE, "utf8").trim(); } catch { return "connected"; } };
const server = http.createServer((request, response) => {
  const current = mode();
  if (current === "unreachable") { request.socket.destroy(); return; }
  const count = current === "connected" ? 4 : 0;
  response.writeHead(count ? 200 : 503, { "content-type": "text/plain" });
  response.end(JSON.stringify({ status: count ? 200 : 503, readyConnections: count, connectorId: "fake" }));
});
server.on("error", () => process.exit(3));
server.listen(port, host, () => { if (mode() === "connected") console.log("INF Registered tunnel connection connIndex=0 location=test"); });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1 << 30);
`;

function fakeCloudflared(): { binary: string; setMode: (mode: "connected" | "zero" | "unreachable") => void; spawns: () => Array<{ pid: number; args: string[] }> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-fake-cloudflared-"));
  // .mjs so node runs it as an ES module; the shebang makes it directly executable like the real one.
  const binary = path.join(dir, "cloudflared.mjs");
  const state = path.join(dir, "state");
  const log = path.join(dir, "spawns.jsonl");
  fs.writeFileSync(binary, `#!${process.execPath}\n${FAKE_CLOUDFLARED}`, { mode: 0o755 });
  fs.writeFileSync(state, "connected");
  // The spawned fake inherits these from this process's environment.
  process.env.FAKE_CF_STATE = state;
  process.env.FAKE_CF_LOG = log;
  return {
    binary,
    setMode: (mode) => fs.writeFileSync(state, mode),
    spawns: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { pid: number; args: string[] }) : [],
  };
}

const FAST: TunnelReadinessOptions = { intervalMs: 60, timeoutMs: 500, unhealthyMs: 400, startupGraceMs: 400, wakeGapMs: 5_000 };

/** A cloudflare TunnelManager over the fake binary, found the way production finds it: KELLY_CLOUDFLARED_PATH. */
function fakeTunnel(binary: string, activity: ActivityLog, extra: Partial<TunnelDeps>): TunnelManager {
  const previous = process.env.KELLY_CLOUDFLARED_PATH;
  process.env.KELLY_CLOUDFLARED_PATH = binary;
  let cloudflaredPath: string;
  try { cloudflaredPath = resolveCloudflaredPath(); } finally {
    if (previous === undefined) delete process.env.KELLY_CLOUDFLARED_PATH; else process.env.KELLY_CLOUDFLARED_PATH = previous;
  }
  assert.equal(cloudflaredPath, binary);
  return new TunnelManager(cfConfig({ port: 1, cloudflaredPath }), activity, {
    spawn,
    which: async (candidate) => fs.existsSync(candidate),
    hasAdminAccount: () => true,
    readiness: FAST,
    ...extra,
  });
}

test("fake cloudflared: argv carries --metrics on loopback; health is false while down, true after a backoff restart; public.log sees lost/reconnected", { timeout: 60_000 }, async () => {
  const fake = fakeCloudflared();
  const sleeps: number[] = [];
  const { activity, events } = recorder();
  const tunnel = fakeTunnel(fake.binary, activity, { sleep: async (ms) => { sleeps.push(ms); await new Promise((resolve) => setTimeout(resolve, 20)); } });
  const h = await publicHarness({ tunnel });
  const health = async (): Promise<boolean> => ((await (await fetch(`${h.base}/api/health`)).json()) as { remote: { active: boolean } }).remote.active;
  const logFile = path.join(h.dataDir, "logs", "public.log");
  const tunnelLines = (): Array<Record<string, unknown>> => fs.existsSync(logFile)
    ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.type === "tunnel")
    : [];
  try {
    await tunnel.start();
    await waitFor(() => tunnel.active, 10_000, "first readiness");
    const first = fake.spawns()[0];
    const metricsIndex = first.args.indexOf("--metrics");
    assert.ok(metricsIndex > 0 && metricsIndex < first.args.indexOf("run"), "--metrics is a tunnel flag, before run");
    const metrics = first.args[metricsIndex + 1];
    assert.match(metrics, /^127\.0\.0\.1:\d+$/);
    const metricsPort = Number(metrics.split(":")[1]);
    assert.ok(metricsPort < 20_241 || metricsPort > 20_245, "never a cloudflared default metrics port");
    assert.deepEqual(first.args.slice(metricsIndex + 2), ["run", "--url", "http://127.0.0.1:1", "test-tunnel"]);
    assert.equal(await health(), true);
    assert.deepEqual((await (await fetch(`${h.base}/api/health`)).json()).remote, { active: true }, "health exposes only the boolean");

    fake.setMode("zero");
    await waitFor(() => !tunnel.active, 2_000, "flip to inactive");
    assert.equal(await health(), false, "health is false while cloudflared runs with zero connections");
    await waitFor(() => fake.spawns().length >= 2, 5_000, "restart");
    assert.equal(sleeps[0], 5_000, "restart goes through the backoff");
    assert.equal(await health(), false);

    fake.setMode("connected");
    await waitFor(() => tunnel.active, 5_000, "recovery");
    assert.equal(await health(), true);

    await waitFor(() => tunnelLines().some((entry) => entry.event === "reconnected"), 2_000, "reconnected log line");
    const lost = tunnelLines().find((entry) => entry.event === "lost");
    assert.equal(lost?.reason, "no-connections");
    const reconnected = tunnelLines().find((entry) => entry.event === "reconnected");
    assert.equal(typeof reconnected?.downMs, "number");
    assert.equal(reconnected?.connections, 4);
    assert.ok(events.some((event) => event.kind === "remote.failed" && event.metadata?.reason === "no-connections"));
    assert.ok(events.some((event) => event.kind === "remote.started" && typeof event.metadata?.downMs === "number"));
  } finally {
    await tunnel.stop();
    await h.close();
  }
  for (const spawned of fake.spawns()) {
    assert.throws(() => process.kill(spawned.pid, 0), "no fake cloudflared is left running");
  }
});

test("fake cloudflared: unreachable metrics restarts it; a simulated wake restarts it too", { timeout: 60_000 }, async () => {
  const fake = fakeCloudflared();
  const sleeps: number[] = [];
  let offset = 0;
  const transitions: TunnelStatusEvent[] = [];
  const { activity } = recorder();
  const tunnel = fakeTunnel(fake.binary, activity, {
    now: () => Date.now() + offset,
    sleep: async (ms) => { sleeps.push(ms); await new Promise((resolve) => setTimeout(resolve, 20)); },
  });
  tunnel.on("status", (event: TunnelStatusEvent) => transitions.push(event));
  try {
    await tunnel.start();
    await waitFor(() => tunnel.active, 10_000, "first readiness");

    fake.setMode("unreachable");
    await waitFor(() => !tunnel.active, 2_000, "flip to inactive");
    assert.ok(transitions.some((event) => event.reason === "metrics-unreachable"));
    await waitFor(() => fake.spawns().length >= 2, 5_000, "restart");
    fake.setMode("connected");
    await waitFor(() => tunnel.active, 5_000, "recovery");

    // Wake: the clock jumps a minute between two polls.
    const before = fake.spawns().length;
    offset += 60_000;
    await waitFor(() => transitions.some((event) => event.reason === "wake-from-sleep"), 2_000, "wake detection");
    await waitFor(() => fake.spawns().length > before, 5_000, "restart after wake");
    await waitFor(() => tunnel.active, 5_000, "reconnected after wake");
    assert.ok(sleeps.length >= 2 && sleeps.every((ms) => ms >= 5_000), "every restart waited out a backoff");
  } finally {
    await tunnel.stop();
  }
});
