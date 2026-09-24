import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HenryRuntime, resolveCloudflaredPath } from "../src/runtime.ts";

/**
 * Guards tests/isolate.mjs: the owner's `.env` can configure a live public tunnel. A test
 * process must see tunnel mode "off" regardless, and must never be able to exec the real
 * `cloudflared` / `tailscale` binaries. This file must be the first loadConfig() in its
 * process (each test file runs in its own process), so the dotenv skip is really exercised.
 */

test("preload: a runtime reports tunnel mode off even when a .env configures a Cloudflare tunnel", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-isolation-test-"));
  fs.cpSync(path.join(process.cwd(), "workflows"), path.join(tempRoot, "workflows"), { recursive: true });
  // A cwd .env shaped exactly like the owner's live one. Without the preload, loadConfig()'s
  // dotenv.config() would load it, because the variables are unset here.
  fs.writeFileSync(path.join(tempRoot, ".env"), "KELLY_TUNNEL=cloudflare\nKELLY_CLOUDFLARE_TUNNEL=owner-tunnel\nKELLY_PUBLIC_HOST=owner.example.com\n");
  const previousCwd = process.cwd();
  const saved = { tunnel: process.env.KELLY_TUNNEL, cf: process.env.KELLY_CLOUDFLARE_TUNNEL, host: process.env.KELLY_PUBLIC_HOST };
  assert.equal(saved.tunnel, "off", "isolate.mjs sets KELLY_TUNNEL=off before any module loads");
  delete process.env.KELLY_TUNNEL;
  delete process.env.KELLY_CLOUDFLARE_TUNNEL;
  delete process.env.KELLY_PUBLIC_HOST;
  process.chdir(tempRoot);
  let runtime: HenryRuntime | undefined;
  try {
    runtime = await HenryRuntime.create(tempRoot);
    assert.equal(process.env.KELLY_TUNNEL, undefined, "no .env may be loaded in a test process");
    assert.equal(process.env.KELLY_CLOUDFLARE_TUNNEL, undefined);
    assert.equal(process.env.KELLY_PUBLIC_HOST, undefined);
    assert.equal(runtime.tunnel.status().mode, "off");
    assert.equal(runtime.tunnel.active, false);
  } finally {
    runtime?.close();
    process.chdir(previousCwd);
    process.env.KELLY_TUNNEL = saved.tunnel;
    process.env.KELLY_CLOUDFLARE_TUNNEL = saved.cf;
    process.env.KELLY_PUBLIC_HOST = saved.host;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("preload: remote-access variables start at their off/default values", () => {
  assert.equal(process.env.HENRY_TEST_ISOLATION, "1");
  assert.equal(process.env.KELLY_TUNNEL, "off");
  assert.equal(process.env.HENRY_TUNNEL, "off");
  assert.equal(process.env.KELLY_CLOUDFLARE_TUNNEL, "");
  assert.equal(process.env.KELLY_PUBLIC_HOST, "");
  assert.equal(process.env.KELLY_PUBLIC_ORIGIN, "");
  assert.ok((process.env.HENRY_DASH_SECRET || "").length >= 32, "a test secret, so the dashboard never appends one to the repo .env");
});

test("preload: the tunnel binaries resolve to a path that does not exist, never the real cloudflared/tailscale", () => {
  const cloudflared = resolveCloudflaredPath();
  const tailscale = process.env.KELLY_TAILSCALE_PATH || "";
  for (const binary of [cloudflared, tailscale]) {
    assert.ok(path.isAbsolute(binary), `${binary} must be an absolute override, not a PATH lookup`);
    assert.ok(binary.startsWith(os.tmpdir()) || binary.startsWith(fs.realpathSync(os.tmpdir())), `${binary} must live under the temp dir`);
    assert.equal(fs.existsSync(binary), false);
  }
});
