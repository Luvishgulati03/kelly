import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HenryRuntime } from "../src/runtime.ts";
import { startDashboard } from "../src/dashboard/server.ts";
import { createUser, resetLoginThrottleForTests } from "../src/dashboard/auth.ts";

/**
 * Harness for the remote-access role/throttle work: a loopback dashboard on a temp data
 * dir (so `createUser` never touches the real repo's `data/dashboard/dashboard.db`), with
 * one admin and one counter account already seeded. `opts.tunnel` swaps in a fake
 * `runtime.tunnel` the same way the task spec's own snippet does, to exercise the bypass
 * turning off whenever a tunnel is CONFIGURED (`status().mode !== "off"`), not only while
 * it is actively forwarding traffic. `KELLY_TUNNEL` is cleared for the whole test process so
 * an operator's real environment variable never leaks into what these tests exercise.
 */
async function withDashboard(
  run: (base: string, runtime: HenryRuntime) => Promise<void>,
  opts: { tunnel?: { active: boolean; mode: string } } = {},
): Promise<void> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-remote-auth-"));
  const previousDataDir = process.env.HENRY_DATA_DIR;
  const previousTunnelEnv = process.env.KELLY_TUNNEL;
  process.env.HENRY_DATA_DIR = path.join(tempRoot, "data");
  delete process.env.KELLY_TUNNEL;
  resetLoginThrottleForTests();
  const runtime = await HenryRuntime.create(tempRoot);
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";
  if (opts.tunnel) {
    Object.defineProperty(runtime, "tunnel", {
      value: { active: opts.tunnel.active, status: () => ({ mode: opts.tunnel!.mode, active: opts.tunnel!.active, restarts: 0 }) },
      configurable: true,
    });
  }
  createUser({ username: "owner", password: "owner-password-1", role: "admin" });
  createUser({ username: "counter", password: "counter-password-1", role: "counter" });
  const server = startDashboard(runtime);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`, runtime);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    runtime.close();
    resetLoginThrottleForTests();
    if (previousDataDir === undefined) delete process.env.HENRY_DATA_DIR;
    else process.env.HENRY_DATA_DIR = previousDataDir;
    if (previousTunnelEnv === undefined) delete process.env.KELLY_TUNNEL;
    else process.env.KELLY_TUNNEL = previousTunnelEnv;
  }
}

async function postLogin(base: string, username: string, password: string): Promise<{ status: number; cookie?: string; location?: string | null }> {
  const response = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }).toString(),
    redirect: "manual",
  });
  const setCookie = response.headers.get("set-cookie");
  return { status: response.status, cookie: setCookie ? setCookie.split(";")[0] : undefined, location: response.headers.get("location") };
}

test("counter role reaches chat and counter voice, and is bounced off mission control", async () => {
  await withDashboard(async (base) => {
    const login = await postLogin(base, "counter", "counter-password-1");
    assert.equal(login.status, 302);
    assert.ok(login.cookie);
    const headers = { cookie: login.cookie! };

    const chat = await fetch(`${base}/chat`, { headers });
    assert.equal(chat.status, 200);
    const voice = await fetch(`${base}/voice`, { headers });
    assert.equal(voice.status, 200);
    const history = await fetch(`${base}/api/chat/history`, { headers });
    assert.equal(history.status, 200);

    const root = await fetch(`${base}/`, { headers, redirect: "manual" });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), "/chat");
  });
});

test("counter is refused every admin-only route; admin keeps them all", async () => {
  await withDashboard(async (base) => {
    const counter = await postLogin(base, "counter", "counter-password-1");
    const admin = await postLogin(base, "owner", "owner-password-1");
    for (const route of ["/api/logs", "/api/usage", "/api/voice/transcripts", "/api/approvals", "/api/remote"]) {
      const counterResponse = await fetch(`${base}${route}`, { headers: { cookie: counter.cookie! } });
      assert.equal(counterResponse.status, 403, route);
      const counterBody = await counterResponse.json() as { error: string };
      assert.equal(counterBody.error, "admin access required");
      const adminResponse = await fetch(`${base}${route}`, { headers: { cookie: admin.cookie! } });
      assert.equal(adminResponse.status, 200, route);
    }
  });
});

test("a counter chat turn can never approve or execute anything, even typing the approval words", async () => {
  await withDashboard(async (base, runtime) => {
    let approveCalls = 0;
    let executeCalls = 0;
    (runtime.agent as unknown as { run: unknown }).run = async () => (
      { runId: "counter-chat", provider: "codex", response: "noted", exitCode: 0, durationMs: 1, events: [] }
    );
    (runtime.approvals as unknown as { list: unknown }).list = async () => ([{
      id: "11111111-1111-1111-1111-111111111111", kind: "social.x-post", title: "t", body: "draft",
      payload: {}, status: "pending", createdAt: new Date().toISOString(),
    }]);
    (runtime as unknown as { approve: unknown }).approve = async () => { approveCalls++; };
    (runtime as unknown as { executeApproval: unknown }).executeApproval = async () => { executeCalls++; return "executed"; };

    const login = await postLogin(base, "counter", "counter-password-1");
    const response = await fetch(`${base}/api/chat/send`, {
      method: "POST",
      headers: { cookie: login.cookie!, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "approve 11111111-1111-1111-1111-111111111111" }),
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(approveCalls, 0, "a counter turn must never approve");
    assert.equal(executeCalls, 0, "a counter turn must never execute");
  });
});

test("five bad passwords lock the account; a 6th correct attempt still gets 429; reset clears it", async () => {
  await withDashboard(async (base, runtime) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const failed = await postLogin(base, "owner", "wrong-password");
      assert.equal(failed.status, 302);
    }
    const lockedOut = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "owner", password: "owner-password-1" }).toString(),
      redirect: "manual",
    });
    assert.equal(lockedOut.status, 429);
    const payload = await lockedOut.json() as { error: string };
    assert.match(payload.error, /15 minute/);

    const events = await runtime.activity.list(50);
    const lockEvents = events.filter((event) => event.kind === "workflow.failed" && event.message.includes("dashboard login locked for owner"));
    assert.equal(lockEvents.length, 1, "the lock must be logged exactly once");

    resetLoginThrottleForTests();
    const afterReset = await postLogin(base, "owner", "owner-password-1");
    assert.equal(afterReset.status, 302);
    assert.equal(afterReset.location, "/");
  });
});

test("the loopback admin bypass turns off while a tunnel is active", async () => {
  await withDashboard(async (base) => {
    const response = await fetch(`${base}/api/status`);
    assert.equal(response.status, 401);
  }, { tunnel: { active: true, mode: "tailscale" } });
});

test("the loopback admin bypass works when no tunnel is configured", async () => {
  await withDashboard(async (base) => {
    const response = await fetch(`${base}/api/status`);
    assert.equal(response.status, 200);
  }, { tunnel: { active: false, mode: "off" } });
});

test("the loopback admin bypass turns off when a tunnel is configured but not currently active", async () => {
  await withDashboard(async (base) => {
    const response = await fetch(`${base}/api/status`);
    assert.equal(response.status, 401);
  }, { tunnel: { active: false, mode: "tailscale" } });
});
