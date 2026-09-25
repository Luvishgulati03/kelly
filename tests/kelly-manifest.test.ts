import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { HenryRuntime } from "../src/runtime.ts";
import { startDashboard } from "../src/dashboard/server.ts";
import { createUser, resetLoginThrottleForTests } from "../src/dashboard/auth.ts";

/**
 * The installable web app manifest and generated icons (item 7): `/manifest.webmanifest`
 * and `/icon-192.png` / `/icon-512.png` must be reachable without auth (so the login page
 * and a fresh, logged-out counter tablet can both install the PWA), and every branded page
 * (talk/counter/voice/login) must link them plus the apple-touch-icon/apple-mobile-web-app
 * meta tags.
 */

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withDashboard(run: (base: string, runtime: HenryRuntime) => Promise<void>): Promise<void> {
  const tempRoot = tempDir("kelly-manifest-");
  const previousDataDir = process.env.HENRY_DATA_DIR;
  process.env.HENRY_DATA_DIR = path.join(tempRoot, "data");
  resetLoginThrottleForTests();
  const runtime = await HenryRuntime.create(tempRoot);
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";
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
  }
}

test("GET /manifest.webmanifest: no auth required, shop name/trade accent, standalone + Talk start_url", async () => {
  await withDashboard(async (base, runtime) => {
    const response = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /manifest\+json/);
    const manifest = await response.json() as Record<string, unknown>;
    assert.equal(manifest.name, runtime.config.shopName);
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.start_url, "/talk");
    assert.equal(manifest.theme_color, runtime.trade.accent.copper);
    assert.ok(Array.isArray(manifest.icons) && (manifest.icons as unknown[]).length >= 1);
  });
});

test("GET /icon-192.png and /icon-512.png: no auth required, valid PNG bytes", async () => {
  await withDashboard(async (base) => {
    for (const route of ["/icon-192.png", "/icon-512.png"]) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers.get("content-type"), "image/png");
      const bytes = Buffer.from(await response.arrayBuffer());
      // PNG signature.
      assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    }
  });
});

test("GET /manifest.webmanifest and icons are reachable by the counter role too", async () => {
  await withDashboard(async (base) => {
    const login = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "counter", password: "counter-password-1" }).toString(),
      redirect: "manual",
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const manifestResponse = await fetch(`${base}/manifest.webmanifest`, { headers: { cookie } });
    assert.equal(manifestResponse.status, 200);
    const iconResponse = await fetch(`${base}/icon-192.png`, { headers: { cookie } });
    assert.equal(iconResponse.status, 200);
  });
});

test("talk.html, counter.html, voice.html and login.html all link the manifest and apple touch icon", async () => {
  await withDashboard(async (base) => {
    const owner = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "owner", password: "owner-password-1" }).toString(),
      redirect: "manual",
    });
    const cookie = owner.headers.get("set-cookie")!.split(";")[0];
    for (const route of ["/talk", "/counter", "/voice"]) {
      const html = await fetch(`${base}${route}`, { headers: { cookie } }).then((r) => r.text());
      assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/, route);
      assert.match(html, /<link rel="apple-touch-icon" href="\/icon-192\.png">/, route);
      assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/, route);
      // The theme-color placeholder must have been substituted, never left raw.
      assert.doesNotMatch(html, /KELLY_THEME_COLOR/, route);
      assert.match(html, /<meta name="theme-color" content="#[0-9a-fA-F]{6}">/, route);
    }
    const loginHtml = await fetch(`${base}/login`).then((r) => r.text());
    assert.match(loginHtml, /<link rel="manifest" href="\/manifest\.webmanifest">/);
    assert.match(loginHtml, /<link rel="apple-touch-icon" href="\/icon-192\.png">/);
    assert.match(loginHtml, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  });
});
