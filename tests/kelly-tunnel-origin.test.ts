import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HenryRuntime } from "../src/runtime.ts";
import { startDashboard } from "../src/dashboard/server.ts";
import { createUser, resetLoginThrottleForTests } from "../src/dashboard/auth.ts";

/**
 * Harness for the tunnel-origin CSRF/cookie/throttle fix: a loopback dashboard on a temp
 * data dir, one seeded admin account, and a stubbed `runtime.tunnel` whose `status().url`
 * the test controls directly — the same stub shape kelly-remote-auth.test.ts uses for its
 * bypass tests, extended with `url` since these tests care about the reported tunnel
 * hostname, not just mode/active. `opts.publicOriginEnv` sets/clears `KELLY_PUBLIC_ORIGIN`
 * for the duration of the run.
 */
async function withDashboard(
  run: (base: string, runtime: HenryRuntime) => Promise<void>,
  opts: { tunnel?: { active: boolean; mode: string; url?: string }; publicOriginEnv?: string } = {},
): Promise<void> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-tunnel-origin-"));
  const previousDataDir = process.env.HENRY_DATA_DIR;
  const previousTunnelEnv = process.env.KELLY_TUNNEL;
  const previousPublicOrigin = process.env.KELLY_PUBLIC_ORIGIN;
  process.env.HENRY_DATA_DIR = path.join(tempRoot, "data");
  delete process.env.KELLY_TUNNEL;
  if (opts.publicOriginEnv === undefined) delete process.env.KELLY_PUBLIC_ORIGIN;
  else process.env.KELLY_PUBLIC_ORIGIN = opts.publicOriginEnv;
  resetLoginThrottleForTests();
  const runtime = await HenryRuntime.create(tempRoot);
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";
  if (opts.tunnel) {
    Object.defineProperty(runtime, "tunnel", {
      value: {
        active: opts.tunnel.active,
        status: () => ({ mode: opts.tunnel!.mode, active: opts.tunnel!.active, url: opts.tunnel!.url, restarts: 0 }),
      },
      configurable: true,
    });
  }
  createUser({ username: "owner", password: "owner-password-1", role: "admin" });
  createUser({ username: "second", password: "second-password-1", role: "admin" });
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
    if (previousDataDir === undefined) delete process.env.HENRY_DATA_DIR; else process.env.HENRY_DATA_DIR = previousDataDir;
    if (previousTunnelEnv === undefined) delete process.env.KELLY_TUNNEL; else process.env.KELLY_TUNNEL = previousTunnelEnv;
    if (previousPublicOrigin === undefined) delete process.env.KELLY_PUBLIC_ORIGIN; else process.env.KELLY_PUBLIC_ORIGIN = previousPublicOrigin;
  }
}

async function postLogin(
  base: string, username: string, password: string, extraHeaders: Record<string, string> = {},
): Promise<{ status: number; cookie?: string; setCookie?: string | null; location?: string | null }> {
  const response = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...extraHeaders },
    body: new URLSearchParams({ username, password }).toString(),
    redirect: "manual",
  });
  const setCookie = response.headers.get("set-cookie");
  return { status: response.status, cookie: setCookie ? setCookie.split(";")[0] : undefined, setCookie, location: response.headers.get("location") };
}

async function chatSend(base: string, cookie: string, originHeader?: string): Promise<Response> {
  return fetch(`${base}/api/chat/send`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      ...(originHeader !== undefined ? { origin: originHeader } : {}),
    },
    body: JSON.stringify({ prompt: "hi" }),
  });
}

test("a tunnel Origin 403s when no tunnel hostname is known", async () => {
  await withDashboard(async (base) => {
    const login = await postLogin(base, "owner", "owner-password-1");
    const response = await chatSend(base, login.cookie!, "https://kelly-mac.tail1234.ts.net");
    assert.equal(response.status, 403);
  }, { tunnel: { active: true, mode: "tailscale" } });
});

test("a mutating request succeeds when the Origin exactly matches the tunnel's reported hostname", async () => {
  await withDashboard(async (base, runtime) => {
    const login = await postLogin(base, "owner", "owner-password-1");
    (runtime.agent as unknown as { run: unknown }).run = async () => (
      { runId: "r", provider: "codex", response: "noted", exitCode: 0, durationMs: 1, events: [] }
    );
    const response = await chatSend(base, login.cookie!, "https://kelly-mac.tail1234.ts.net");
    assert.equal(response.status, 200);
  }, { tunnel: { active: true, mode: "tailscale", url: "https://kelly-mac.tail1234.ts.net" } });
});

test("an unrelated ts.net host 403s even while a tunnel is active", async () => {
  await withDashboard(async (base) => {
    const login = await postLogin(base, "owner", "owner-password-1");
    const response = await chatSend(base, login.cookie!, "https://evil.ts.net");
    assert.equal(response.status, 403);
  }, { tunnel: { active: true, mode: "tailscale", url: "https://kelly-mac.tail1234.ts.net" } });
});

test("a suffix look-alike host 403s (no suffix/wildcard match)", async () => {
  await withDashboard(async (base) => {
    const login = await postLogin(base, "owner", "owner-password-1");
    const response = await chatSend(base, login.cookie!, "https://kelly-mac.tail1234.ts.net.evil.com");
    assert.equal(response.status, 403);
  }, { tunnel: { active: true, mode: "tailscale", url: "https://kelly-mac.tail1234.ts.net" } });
});

test("KELLY_PUBLIC_ORIGIN is trusted even when the tunnel status never reports it", async () => {
  await withDashboard(async (base, runtime) => {
    const login = await postLogin(base, "owner", "owner-password-1");
    (runtime.agent as unknown as { run: unknown }).run = async () => (
      { runId: "r", provider: "codex", response: "noted", exitCode: 0, durationMs: 1, events: [] }
    );
    const response = await chatSend(base, login.cookie!, "https://kelly.example.com");
    assert.equal(response.status, 200);
  }, { tunnel: { active: false, mode: "off" }, publicOriginEnv: "https://kelly.example.com" });
});

test("login over the tunnel origin sets a Secure cookie; local login does not", async () => {
  await withDashboard(async (base) => {
    const remote = await postLogin(base, "owner", "owner-password-1", { origin: "https://kelly-mac.tail1234.ts.net" });
    assert.equal(remote.status, 302);
    assert.match(remote.setCookie || "", /Secure/);

    const local = await postLogin(base, "second", "second-password-1");
    assert.equal(local.status, 302);
    assert.doesNotMatch(local.setCookie || "", /Secure/);
  }, { tunnel: { active: true, mode: "tailscale", url: "https://kelly-mac.tail1234.ts.net" } });
});

test("5 failed logins for one user through the tunnel do not lock out a second user", async () => {
  await withDashboard(async (base) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const failed = await postLogin(base, "owner", "wrong-password", { origin: "https://kelly-mac.tail1234.ts.net" });
      assert.equal(failed.status, 302);
    }
    const ownerLocked = await postLogin(base, "owner", "owner-password-1", { origin: "https://kelly-mac.tail1234.ts.net" });
    assert.equal(ownerLocked.status, 429);

    const secondStillWorks = await postLogin(base, "second", "second-password-1", { origin: "https://kelly-mac.tail1234.ts.net" });
    assert.equal(secondStillWorks.status, 302);
    assert.equal(secondStillWorks.location, "/");
  }, { tunnel: { active: true, mode: "tailscale", url: "https://kelly-mac.tail1234.ts.net" } });
});

test("rotating a spoofed X-Forwarded-For per attempt does not escape the lockout", async () => {
  // Proxy headers make these requests tunnelled (src/public/surface.ts isPublicRequest), where
  // login exists only with KELLY_REMOTE_LOGIN=on.
  const previousRemoteLogin = process.env.KELLY_REMOTE_LOGIN;
  process.env.KELLY_REMOTE_LOGIN = "on";
  try {
  await withDashboard(async (base) => {
    const origin = "https://kelly-mac.tail1234.ts.net";
    for (let attempt = 0; attempt < 5; attempt++) {
      const failed = await postLogin(base, "owner", "wrong-password", {
        origin, "x-forwarded-proto": "https", "x-forwarded-for": `203.0.113.${attempt + 1}`, "cf-connecting-ip": `198.51.100.${attempt + 1}`,
      });
      assert.equal(failed.status, 302);
    }
    const fresh = await postLogin(base, "owner", "owner-password-1", {
      origin, "x-forwarded-proto": "https", "x-forwarded-for": "192.0.2.99", "cf-connecting-ip": "192.0.2.99",
    });
    assert.equal(fresh.status, 429, "a new forwarded IP must not reset the per-username lock");
  }, { tunnel: { active: true, mode: "funnel", url: "https://kelly-mac.tail1234.ts.net" } });
  } finally {
    if (previousRemoteLogin === undefined) delete process.env.KELLY_REMOTE_LOGIN; else process.env.KELLY_REMOTE_LOGIN = previousRemoteLogin;
  }
});

test("through the tunnel (proxy headers) the login is off by default: 404, no cookie", async () => {
  const previousRemoteLogin = process.env.KELLY_REMOTE_LOGIN;
  delete process.env.KELLY_REMOTE_LOGIN;
  try {
    await withDashboard(async (base) => {
      const attempt = await postLogin(base, "owner", "owner-password-1", {
        origin: "https://kelly-mac.tail1234.ts.net", "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.9", "cf-connecting-ip": "203.0.113.9",
      });
      assert.equal(attempt.status, 404);
      assert.equal(attempt.setCookie, null);
    }, { tunnel: { active: true, mode: "cloudflare", url: "https://kelly-mac.tail1234.ts.net" } });
  } finally {
    if (previousRemoteLogin !== undefined) process.env.KELLY_REMOTE_LOGIN = previousRemoteLogin;
  }
});

test("a counter login lands on its counter home by mode: talk, conversation, review", async () => {
  await withDashboard(async (base, runtime) => {
    createUser({ username: "counter", password: "counter-password-1", role: "counter" });
    const origin = "https://kelly-mac.tail1234.ts.net";
    const login = await postLogin(base, "counter", "counter-password-1", { origin });
    assert.equal(login.status, 302);
    assert.equal(login.location, "/");
    const home = async () => (await fetch(`${base}/`, { headers: { cookie: login.cookie!, accept: "text/html" }, redirect: "manual" })).headers.get("location");
    const settingsPath = runtime.config.settingsPath;
    const setMode = (mode: string) => {
      const current = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({ ...current, voice: { ...(current.voice ?? {}), counterMode: mode } }));
    };
    setMode("talk");
    assert.equal(await home(), "/talk");
    setMode("conversation");
    assert.equal(await home(), "/counter");
    setMode("review");
    assert.equal(await home(), "/chat");

    // Everything the Talk page needs is reachable for the counter over the tunnel origin.
    setMode("talk");
    const talk = await fetch(`${base}/talk`, { headers: { cookie: login.cookie! } });
    assert.equal(talk.status, 200);
    const status = await fetch(`${base}/api/voice/status`, { headers: { cookie: login.cookie! } });
    assert.equal(status.status, 200);
    const conversation = await fetch(`${base}/api/conversations`, {
      method: "POST", headers: { cookie: login.cookie!, origin, "content-type": "application/json" }, body: JSON.stringify({ title: "Talk" }),
    });
    assert.equal(conversation.status, 200);
    const session = await fetch(`${base}/api/voice/talk/session`, {
      method: "POST", headers: { cookie: login.cookie!, origin, "content-type": "application/json" }, body: JSON.stringify({ event: "start" }),
    });
    assert.equal(session.status, 200);
    const vendor = await fetch(`${base}/vendor/vad/bundle.min.js`, { headers: { cookie: login.cookie! } });
    assert.equal(vendor.status, 200);
    // Admin routes stay closed to the counter.
    const settings = await fetch(`${base}/api/voice/settings`, {
      method: "POST", headers: { cookie: login.cookie!, origin, "content-type": "application/json" }, body: JSON.stringify({ counterMode: "review" }),
    });
    assert.equal(settings.status, 403);
  }, { tunnel: { active: true, mode: "funnel", url: "https://kelly-mac.tail1234.ts.net" } });
});

test("/api/health reports remote.active:false with no tunnel, with no session cookie", async () => {
  await withDashboard(async (base) => {
    const health = await (await fetch(`${base}/api/health`)).json() as { ok: boolean; remote?: { active: boolean } };
    assert.equal(health.ok, true);
    assert.equal(health.remote?.active, false);
  });
});

test("/api/health reports remote.active:true when a stubbed tunnel reports active, with no session cookie", async () => {
  await withDashboard(async (base) => {
    const health = await (await fetch(`${base}/api/health`)).json() as { ok: boolean; remote?: { active: boolean } };
    assert.equal(health.ok, true);
    assert.equal(health.remote?.active, true);
  }, { tunnel: { active: true, mode: "tailscale", url: "https://kelly-mac.tail1234.ts.net" } });
});

test("/api/health has no cross-site readers by default (KELLY_HEALTH_CORS_ORIGINS unset)", async () => {
  const previous = process.env.KELLY_HEALTH_CORS_ORIGINS;
  delete process.env.KELLY_HEALTH_CORS_ORIGINS;
  try {
    await withDashboard(async (base) => {
      for (const origin of ["https://portfolio.example.com", "https://www.portfolio.example.com", "https://evil.example"]) {
        const response = await fetch(`${base}/api/health`, { headers: { origin } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("access-control-allow-origin"), null, origin);
      }
    });
  } finally {
    if (previous === undefined) delete process.env.KELLY_HEALTH_CORS_ORIGINS; else process.env.KELLY_HEALTH_CORS_ORIGINS = previous;
  }
});

test("/api/health is readable cross-site by exactly the origins listed in KELLY_HEALTH_CORS_ORIGINS", async () => {
  const previous = process.env.KELLY_HEALTH_CORS_ORIGINS;
  process.env.KELLY_HEALTH_CORS_ORIGINS = "https://portfolio.example.com,https://www.portfolio.example.com";
  try {
    await withDashboard(async (base) => {
      for (const origin of ["https://portfolio.example.com", "https://www.portfolio.example.com"]) {
        const response = await fetch(`${base}/api/health`, { headers: { origin } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("access-control-allow-origin"), origin);
        assert.equal(((await response.json()) as { ok: boolean }).ok, true);
      }
      for (const origin of ["https://evil.example", "https://portfolio.example.com.evil.example", "http://portfolio.example.com"]) {
        const response = await fetch(`${base}/api/health`, { headers: { origin } });
        assert.equal(response.headers.get("access-control-allow-origin"), null, origin);
      }
      const status = await fetch(`${base}/api/status`, { headers: { origin: "https://portfolio.example.com" } });
      assert.equal(status.headers.get("access-control-allow-origin"), null, "no other route opens up");
    });
  } finally {
    if (previous === undefined) delete process.env.KELLY_HEALTH_CORS_ORIGINS; else process.env.KELLY_HEALTH_CORS_ORIGINS = previous;
  }
});
