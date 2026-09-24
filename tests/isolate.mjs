/**
 * THE TEST SUITE MUST NEVER TOUCH THE REPO'S `data/` OR ACTUAL HOME DIRECTORIES.
 *
 * Preloaded by `npm test` (package.json: `tsx --import ./tests/isolate.mjs --test …`), before
 * a single test module is evaluated, so it is in place no matter which file runs first.
 *
 * Why a preload and not a line in each test's freshEnv(): a module resolves its database as
 * `process.env.HENRY_DATA_DIR || process.env.LAVU_DATA_DIR || "data"` AT CALL TIME, and a test
 * only escapes the repo for the modules it remembered to `configure*()`. That list is a promise
 * every test file has to keep about a graph it does not import directly — a single surface
 * reaches a dozen DB-opening modules — and it was already broken: the P5 audit found rows
 * sitting in this deployment's real database, written because those files configured the
 * modules they knew about and a newer one had been added underneath them.
 *
 * So the fallback itself is moved. A module a test forgot to point at a tmpdir now lands in a
 * scratch directory instead of the live deployment, and the next DB-opening module is covered
 * on the day it lands rather than on the day someone notices.
 *
 * `src/config.ts` resolves the WHOLE deployment's dataDir from the same variable
 * (`env("DATA_DIR")` → `HENRY_DATA_DIR` / `LAVU_DATA_DIR`), so engram.db, activity.jsonl,
 * settings.json and the rest of the agent's state move with it. A test that forgot to point at
 * a tmpdir was writing into the running deployment; now it cannot.
 *
 * An already-set HENRY_DATA_DIR (or the legacy LAVU_DATA_DIR) is honoured rather than
 * overwritten, so a developer can point a run somewhere specific and still get the guard.
 * Same applies to KELLY_DATA_DIR and KELLY_MEMORY_DIR for Kelly profile tests.
 *
 * THE TEST SUITE MUST NEVER SEE THE OWNER'S REMOTE ACCESS OR SECRETS, AND NEVER START A REAL TUNNEL.
 *
 * The owner's repo `.env` can carry a live public tunnel (KELLY_TUNNEL=cloudflare,
 * KELLY_CLOUDFLARE_TUNNEL=<named tunnel>, KELLY_PUBLIC_HOST=<public hostname>). If a test loaded
 * it, (a) a tunnel would count as "configured", the loopback admin bypass would switch off and
 * dashboard tests would fail with auth errors, and (b) anything that called startTunnel() would
 * run a second `cloudflared` connector on the owner's named tunnel, which would then receive a
 * share of real public traffic. So, before any module loads:
 *
 *  1. HENRY_TEST_ISOLATION=1 makes src/config.ts (and the `voice` CLI path) skip dotenv
 *     entirely, so neither the repo `.env` nor a cwd `.env` is read in a test process. This
 *     also covers tests that `delete process.env.X` before their first loadConfig(): dotenv
 *     only fills unset variables, so without this it would hand the owner's value back.
 *  2. Every remote-access variable is set EXPLICITLY to its "off/default" meaning, even if the
 *     developer's shell exported it (a stray `export KELLY_TUNNEL=cloudflare` must not reach
 *     tests either): KELLY_TUNNEL/HENRY_TUNNEL = "off" (tunnelModeFromEnv maps anything but
 *     tailscale|funnel|cloudflare to off); KELLY_CLOUDFLARE_TUNNEL, KELLY_PUBLIC_HOST and
 *     KELLY_PUBLIC_ORIGIN = "" (every reader does `?.trim() || undefined` / truthiness, so ""
 *     is the same as unset). KELLY_TRADE, KELLY_SHOP_NAME and KELLY_COUNTER_* are not touched:
 *     the owner's `.env` is no longer read at all, and tests that need them set them per test.
 *  3. KELLY_CLOUDFLARED_PATH and KELLY_TAILSCALE_PATH point at a path inside a fresh temp dir
 *     that does not exist, so even a test that turns a tunnel on can only ever spawn ENOENT,
 *     never the real `cloudflared` or `tailscale` binary.
 *  4. HENRY_DASH_SECRET gets a random per-process value: with no `.env` loaded, the dashboard
 *     would otherwise generate one and APPEND it to the repo `.env` (src/dashboard/auth.ts).
 *
 * Tests that exercise these variables still set/delete them inside the test and restore them
 * afterwards; the preload only fixes the starting point.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Henry test isolation
if (!process.env.HENRY_DATA_DIR && !process.env.LAVU_DATA_DIR) {
  process.env.HENRY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "henry-test-data-"));
}

if (!process.env.HENRY_MEMORY_DIR) {
  process.env.HENRY_MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "henry-test-memory-"));
}

// Kelly test isolation (separate from Henry)
if (!process.env.KELLY_DATA_DIR) {
  process.env.KELLY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-test-data-"));
}

if (!process.env.KELLY_MEMORY_DIR) {
  process.env.KELLY_MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-test-memory-"));
}

// Remote-access / owner-identity isolation (see header). Unconditional on purpose.
process.env.HENRY_TEST_ISOLATION = "1";
process.env.KELLY_TUNNEL = "off";
process.env.HENRY_TUNNEL = "off";
process.env.KELLY_CLOUDFLARE_TUNNEL = "";
process.env.KELLY_PUBLIC_HOST = "";
process.env.KELLY_PUBLIC_ORIGIN = "";
const noBinaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-test-no-binaries-"));
process.env.KELLY_CLOUDFLARED_PATH = path.join(noBinaryDir, "missing", "cloudflared");
process.env.KELLY_TAILSCALE_PATH = path.join(noBinaryDir, "missing", "tailscale");
process.env.HENRY_DASH_SECRET = crypto.randomBytes(32).toString("hex");

// Hang guard. A test that fails an assertion before its own `server.close()` used to leave an
// http.Server (and any open SSE response) listening, which keeps that test file's process
// alive forever: `npm test` then hangs instead of reporting the failure. In each test-file
// process (NODE_TEST_CONTEXT is set there, not in the orchestrating runner), remember every
// server that starts listening and force-close whatever is still open once the file's tests
// have all finished. Servers a test closed itself are untouched.
if (process.env.NODE_TEST_CONTEXT) {
  const http = await import("node:http");
  const { after } = await import("node:test");
  const openServers = new Set();
  const originalListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function patchedListen(...args) {
    openServers.add(this);
    this.once("close", () => openServers.delete(this));
    return originalListen.apply(this, args);
  };
  after(() => {
    for (const server of openServers) {
      server.closeAllConnections?.();
      server.close();
    }
  });
}
