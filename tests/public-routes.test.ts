import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { PUBLIC_ORIGIN, cookieFrom, publicHarness, tunnel } from "./public-harness.ts";
import { TUNNEL_LOGIN_ROUTES } from "../src/dashboard/server.ts";
import { PUBLIC_TUNNEL_ROUTES, isPublicRequest, matchPublicRoute } from "../src/public/surface.ts";
import { createUser, issueSession, verifyLogin } from "../src/dashboard/auth.ts";

/**
 * THE TUNNEL SEES ONLY THE ALLOWLIST. Every route the dashboard server registers is read straight
 * out of src/dashboard/server.ts (string routes and regex routes alike) and requested through the
 * tunnel with every method and both Accept kinds; a future route therefore cannot leak by default.
 * Unauthenticated, only the public surface's allowlist may answer (and, with KELLY_REMOTE_LOGIN=on,
 * the login routes); everything else is a 404 or a 302 to "/". Loopback stays the owner's
 * dashboard exactly as before.
 */

const PASSWORD = "correct horse battery staple";

function registeredRoutes(): string[] {
  const source = fs.readFileSync(new URL("../src/dashboard/server.ts", import.meta.url), "utf8");
  const paths = new Set<string>();
  for (const match of source.matchAll(/(?:route|url\.pathname) === "([^"]+)"/g)) paths.add(match[1]);
  for (const match of source.matchAll(/(?:url\.pathname|route)\.match\(\/\^(.+?)\$\/\)/g)) {
    const pattern = match[1].replace(/\\\//g, "/").replace(/\(\[\^\/\]\+\)/g, "sample-id").replace(/\(\[A-Za-z0-9-\]\{1,64\}\)/g, "sample-id");
    const alternatives = /\(([a-z|-]+)\)/.exec(pattern);
    if (alternatives) for (const option of alternatives[1].split("|")) paths.add(pattern.replace(alternatives[0], option));
    else paths.add(pattern);
  }
  // Prefix-gated families the server reaches through startsWith().
  for (const prefix of ["/api/designs/sample-id", "/api/designs/stats", "/vendor/vad/bundle.min.js", "/api/chat/anything"]) paths.add(prefix);
  for (const entry of PUBLIC_TUNNEL_ROUTES) paths.add(entry.split(" ")[1].replace("*", "bundle.min.js"));
  // Paths no route owns, and traversal attempts: all must stay closed.
  for (const extra of ["/api/unknown", "/index.html", "/explore", "/explore/", "/api/public", "/api/public/unknown", "/%2e%2e/api/status",
    "/explore/../api/approvals", "/vendor/vad/../../package.json", "/api/public/designs/../../api/approvals", "/favicon.ico", "/login", "/logout", "/talk", "/counter", "/voice"]) paths.add(extra);
  return [...paths];
}

async function raw(port: number, method: string, pathName: string, headers: Record<string, string>): Promise<{ status: number; location?: string; body: string }> {
  // Raw http (not fetch) so the path is sent exactly as written, traversal attempts included.
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path: pathName, headers: { ...headers, ...(method !== "GET" ? { "content-type": "application/json", "content-length": "2" } : {}) } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; if (body.length > 4096) response.destroy(); });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, location: response.headers.location, body }));
      response.on("close", () => resolve({ status: response.statusCode ?? 0, location: response.headers.location, body }));
    });
    request.on("error", reject);
    request.setTimeout(5_000, () => { request.destroy(new Error(`timeout ${method} ${pathName}`)); });
    if (method !== "GET") request.write("{}");
    request.end();
  });
}

function allowlisted(method: string, pathName: string, loginOn = false): boolean {
  const route = pathName.split("?")[0].replace(/\/+$/, "") || "/";
  return Boolean(matchPublicRoute(method, route)) || (loginOn && TUNNEL_LOGIN_ROUTES.includes(`${method} ${route}`));
}

async function walk(port: number, headers: Record<string, string>, loginOn: boolean): Promise<string[]> {
  const leaks: string[] = [];
  for (const pathName of registeredRoutes()) {
    for (const method of ["GET", "POST", "PATCH", "DELETE", "PUT"]) {
      for (const accept of ["text/html", "application/json"]) {
        const result = await raw(port, method, pathName, { ...tunnel(), accept, origin: PUBLIC_ORIGIN, ...headers });
        if (allowlisted(method, new URL(pathName, "http://x").pathname, loginOn)) {
          if (result.status >= 500) leaks.push(`${method} ${pathName} errored through the tunnel (${result.status})`);
          continue;
        }
        const closed = result.status === 404 || (result.status === 302 && result.location === "/");
        if (!closed) leaks.push(`${method} ${pathName} [${accept}] -> ${result.status}${result.location ? ` ${result.location}` : ""}`);
      }
    }
  }
  return leaks;
}

test("route walk: an unauthenticated tunnel request reaches ONLY the public allowlist (remote login off, the default)", async () => {
  const h = await publicHarness();
  try {
    const port = Number(new URL(h.base).port);
    const paths = registeredRoutes();
    assert.ok(paths.length > 70, `expected the whole dashboard route table, found ${paths.length}`);
    for (const must of ["/api/approvals", "/api/memory/recall", "/api/chat/send", "/api/chat/history", "/api/conversations", "/api/settings/provider", "/api/events",
      "/api/voice/transcripts", "/api/voice/audio/sample-id", "/api/quotes/sample-id", "/api/quotes/sample-id/export", "/api/usage", "/api/logs", "/api/activity",
      "/memory", "/admin/knowledge", "/api/approvals/sample-id/execute", "/api/attachments/sample-id", "/talk", "/chat", "/counter", "/", "/login"]) {
      assert.ok(paths.includes(must), `route extraction missed ${must}`);
    }
    const leaks = await walk(port, {}, false);
    assert.deepEqual(leaks, [], "only the allowlist may answer an unauthenticated tunnel request");
    assert.equal(h.runs.length, 0, "the walk never started a model turn");
  } finally { await h.close(); }
});

test("route walk with KELLY_REMOTE_LOGIN=on: still only the allowlist plus the login routes without a session", async () => {
  const h = await publicHarness({ env: { KELLY_REMOTE_LOGIN: "on" } });
  try {
    const leaks = await walk(Number(new URL(h.base).port), {}, true);
    assert.deepEqual(leaks, []);
  } finally { await h.close(); }
});

test("the local-admin bypass, the dashboard token and any session never apply through the tunnel by default", async () => {
  const h = await publicHarness();
  try {
    h.runtime.config.dashboardToken = "local-dashboard-token-123";
    // Locally (loopback, no proxy headers) the owner's dashboard works exactly as before.
    assert.equal((await fetch(`${h.base}/api/approvals`)).status, 200);
    const local = await (await fetch(`${h.base}/`, { headers: { accept: "text/html" } })).text();
    assert.match(local, /<html/i);
    assert.doesNotMatch(local, /Explore Kelly/);
    // Through the tunnel the socket peer is still 127.0.0.1, but that grants nothing.
    assert.equal((await fetch(`${h.base}/api/approvals`, { headers: tunnel() })).status, 404);
    assert.equal((await fetch(`${h.base}/api/approvals`, { headers: { ...tunnel(), authorization: "Bearer local-dashboard-token-123", "x-henry-token": "local-dashboard-token-123" } })).status, 404);
    // A valid admin session made locally is ignored through the tunnel while remote login is off.
    createUser({ username: "owner", password: PASSWORD, role: "admin" });
    const session = issueSession(verifyLogin("owner", PASSWORD)!).cookie.split(";")[0];
    assert.equal((await fetch(`${h.base}/api/approvals`)).status, 200);
    assert.equal((await fetch(`${h.base}/api/approvals`, { headers: { ...tunnel(), cookie: session } })).status, 404);
    const home = await fetch(`${h.base}/`, { headers: { ...tunnel(), cookie: session, accept: "text/html" } });
    assert.match(await home.text(), /Explore Kelly/, "the tunnel's / is always the Explore page");
    // A visitor cookie grants nothing.
    const page = await fetch(`${h.base}/explore/chat`, { headers: tunnel() });
    const visitorCookie = cookieFrom(page);
    assert.match(visitorCookie, /^kelly_visitor=/);
    assert.match(page.headers.getSetCookie().join(";"), /HttpOnly.*Secure|Secure.*HttpOnly/);
    assert.equal((await fetch(`${h.base}/api/conversations`, { headers: { ...tunnel(), cookie: visitorCookie } })).status, 404);
    // Login is off: the page bounces to Explore and the form post is closed.
    const login = await fetch(`${h.base}/login`, { redirect: "manual", headers: { ...tunnel(), accept: "text/html" } });
    assert.equal(login.status, 302);
    assert.equal(login.headers.get("location"), "/");
    const post = await fetch(`${h.base}/login`, {
      method: "POST", redirect: "manual", headers: { ...tunnel(), origin: PUBLIC_ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "owner", password: PASSWORD }).toString(),
    });
    assert.equal(post.status, 404);
    assert.equal(post.headers.getSetCookie().length, 0);
    const config = await (await fetch(`${h.base}/api/public/config`, { headers: tunnel() })).json() as Record<string, unknown>;
    assert.equal(config.remoteLogin, false);
  } finally { await h.close(); }
});

test("KELLY_REMOTE_LOGIN=on: the existing login works through the tunnel with Secure SameSite=Strict, exact-origin CSRF and the username throttle", async () => {
  const h = await publicHarness({ env: { KELLY_REMOTE_LOGIN: "on" } });
  try {
    createUser({ username: "owner", password: PASSWORD, role: "admin" });
    createUser({ username: "tablet", password: PASSWORD, role: "counter" });
    const login = (username: string, password: string, headers: Record<string, string> = {}): Promise<Response> => fetch(`${h.base}/login`, {
      method: "POST", redirect: "manual",
      headers: { ...tunnel(), origin: PUBLIC_ORIGIN, "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ username, password }).toString(),
    });
    // The login page is served (with a strict CSP) and a cross-site post is refused.
    const page = await fetch(`${h.base}/login`, { headers: { ...tunnel(), accept: "text/html" } });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal((await login("owner", PASSWORD, { origin: "https://evil.example.com" })).status, 403);
    assert.equal((await login("owner", PASSWORD, { origin: "https://kelly.example.com.evil.test" })).status, 403);

    const ok = await login("owner", PASSWORD);
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get("location"), "/");
    const setCookie = ok.headers.getSetCookie().find((value) => value.startsWith("kelly_sess="))!;
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Secure/);
    const cookie = cookieFrom(ok);
    // The dashboard, as today.
    assert.equal((await fetch(`${h.base}/api/approvals`, { headers: { ...tunnel(), cookie } })).status, 200);
    const home = await (await fetch(`${h.base}/`, { headers: { ...tunnel(), cookie, accept: "text/html" } })).text();
    assert.doesNotMatch(home, /Explore Kelly/);
    // Exact-origin CSRF on every state change through the tunnel.
    const provider = (origin?: string): Promise<Response> => fetch(`${h.base}/api/settings/provider`, {
      method: "POST", headers: { ...tunnel(), cookie, "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ provider: "codex" }),
    });
    assert.equal((await provider("https://evil.example.com")).status, 403);
    assert.equal((await provider("http://127.0.0.1:7338")).status, 403, "a loopback origin is not trusted through the tunnel");
    assert.equal((await provider()).status, 403, "a state change without Origin is refused through the tunnel");
    assert.equal((await provider(PUBLIC_ORIGIN)).status, 200);
    // Logout ends the session and lands back on Explore.
    const logout = await fetch(`${h.base}/logout`, { redirect: "manual", headers: { ...tunnel(), cookie } });
    assert.equal(logout.headers.get("location"), "/");
    assert.match(logout.headers.getSetCookie().join(";"), /kelly_sess=;.*Max-Age=0/);
    assert.equal((await fetch(`${h.base}/api/approvals`, { headers: { ...tunnel(), cookie } })).status, 404);

    // The counter account keeps its narrow reach.
    const counter = cookieFrom(await login("tablet", PASSWORD));
    assert.equal((await fetch(`${h.base}/api/approvals`, { headers: { ...tunnel(), cookie: counter } })).status, 403);

    // Throttle keyed on the username, never on a forwarded address.
    for (let attempt = 0; attempt < 5; attempt++) {
      const ip = `198.51.100.${attempt + 1}`;
      await login("owner", "wrong password here", { "cf-connecting-ip": ip, "x-forwarded-for": ip });
    }
    const locked = await login("owner", PASSWORD, { "cf-connecting-ip": "192.0.2.99", "x-forwarded-for": "192.0.2.99" });
    assert.equal(locked.status, 429, "even the right password waits out the lock");
    assert.equal(locked.headers.getSetCookie().some((value) => value.startsWith("kelly_sess=")), false);
  } finally { await h.close(); }
});

test("loopback is unchanged: the owner's dashboard, login page and local preview of the public pages", async () => {
  const h = await publicHarness();
  try {
    assert.equal((await fetch(`${h.base}/api/approvals`)).status, 200);
    assert.equal((await fetch(`${h.base}/login`)).status, 200);
    assert.equal((await fetch(`${h.base}/api/status`)).status, 200);
    // The owner may preview the public pages locally; "/" stays the dashboard.
    assert.equal((await fetch(`${h.base}/explore/chat`)).status, 200);
    assert.equal((await fetch(`${h.base}/api/public/config`)).status, 200);
    assert.equal((await fetch(`${h.base}/api/public/unknown`)).status, 404);
  } finally { await h.close(); }
});

test("isPublicRequest: fail-closed classification", () => {
  const request = (headers: Record<string, string>, remoteAddress = "127.0.0.1"): http.IncomingMessage => ({ headers, socket: { remoteAddress } as net.Socket } as unknown as http.IncomingMessage);
  const local = { allowRemoteDashboard: false };
  assert.equal(isPublicRequest(request({ host: "127.0.0.1:7338" }), local), false);
  assert.equal(isPublicRequest(request({ host: "localhost:7338" }), local), false);
  assert.equal(isPublicRequest(request({ host: "[::1]:7338" }, "::1"), local), false);
  assert.equal(isPublicRequest(request({ host: "127.0.0.1:7338" }, "::ffff:127.0.0.1"), local), false);
  for (const header of ["cf-connecting-ip", "cf-ray", "cf-visitor", "cf-ipcountry", "cdn-loop", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip", "tailscale-user-login"]) {
    assert.equal(isPublicRequest(request({ host: "127.0.0.1:7338", [header]: "x" }), local), true, header);
  }
  assert.equal(isPublicRequest(request({ host: "kelly.example.com" }), local), true, "a non-loopback Host (e.g. DNS rebinding) is public");
  assert.equal(isPublicRequest(request({}), local), true, "no Host header is public");
  assert.equal(isPublicRequest(request({ host: "127.0.0.1:7338" }, "192.168.1.20"), local), true, "a non-loopback peer is public");
  assert.equal(isPublicRequest(request({ host: "192.168.1.5:7338" }, "192.168.1.20"), { allowRemoteDashboard: true }), false, "explicit token remote dashboard keeps its own path");
  assert.equal(isPublicRequest(request({ host: "192.168.1.5:7338", "cf-ray": "x" }, "192.168.1.20"), { allowRemoteDashboard: true }), true);
});

test("matchPublicRoute: exact entries, one-segment wildcards, and nothing else", () => {
  assert.equal(matchPublicRoute("GET", "/"), "GET /");
  assert.equal(matchPublicRoute("GET", "/explore/talk/"), "GET /explore/talk");
  assert.equal(matchPublicRoute("POST", "/explore/talk"), undefined);
  assert.equal(matchPublicRoute("GET", "/vendor/vad/bundle.min.js"), "GET /vendor/vad/*");
  assert.equal(matchPublicRoute("GET", "/vendor/vad/a/b"), undefined);
  assert.equal(matchPublicRoute("POST", "/vendor/vad/bundle.min.js"), undefined);
  assert.equal(matchPublicRoute("GET", "/api/public/designs/dsg_0123456789abcdef/image"), "GET /api/public/designs/*/image");
  assert.equal(matchPublicRoute("GET", "/api/public/designs/a/b/image"), undefined);
  assert.equal(matchPublicRoute("GET", "/api/public/designs/*/image".replace("*", "x")), "GET /api/public/designs/*/image");
  assert.equal(matchPublicRoute("GET", "/api/designs"), undefined);
  assert.equal(matchPublicRoute("GET", "/api/public/chat"), undefined);
  assert.equal(matchPublicRoute("POST", "/api/public/chat"), "POST /api/public/chat");
});
