import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error JavaScript launcher intentionally has no build step.
import { shellQuote, terminalCommand, waitReady, assertFree, supervise, resolveTunnelMode, resolvePublicOrigin, maybeKeepAwake } from "../bin/start.mjs";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

test("terminal launch quotes paths and preserves demo mode", () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.match(terminalCommand("/a b/node", "/repo/kelly.mjs", true), /'--foreground' '--demo'$/);
});

test("terminal launch also preserves --public alongside --demo --trade", () => {
  assert.match(
    terminalCommand("/a b/node", "/repo/kelly.mjs", true, "boutique", true),
    /'--foreground' '--demo' '--trade' 'boutique' '--public'$/,
  );
});

test("resolveTunnelMode: --public sets funnel for both the demo and a real install; without it, off", () => {
  assert.equal(resolveTunnelMode(["--demo", "--trade", "boutique", "--public"], {}), "funnel");
  assert.equal(resolveTunnelMode(["--public"], {}), "funnel");
  assert.equal(resolveTunnelMode(["--demo", "--trade", "boutique"], {}), "off");
  assert.equal(resolveTunnelMode([], {}), "off");
});

test("resolveTunnelMode: bare --public picks cloudflare when KELLY_CLOUDFLARE_TUNNEL is set (env or repo .env), funnel otherwise", () => {
  assert.equal(resolveTunnelMode(["--public"], { KELLY_CLOUDFLARE_TUNNEL: "kelly-test" }), "cloudflare");
  assert.equal(resolveTunnelMode(["--demo", "--trade", "boutique", "--public"], { KELLY_CLOUDFLARE_TUNNEL: "kelly-test" }), "cloudflare");
  assert.equal(resolveTunnelMode(["--public"], {}), "funnel");
  assert.equal(resolveTunnelMode(["--public"], { KELLY_CLOUDFLARE_TUNNEL: "" }), "funnel");
});

test("resolveTunnelMode: --public tailscale / --public cloudflare force one transport regardless of env", () => {
  assert.equal(resolveTunnelMode(["--public", "tailscale"], { KELLY_CLOUDFLARE_TUNNEL: "kelly-test" }), "tailscale");
  assert.equal(resolveTunnelMode(["--public", "cloudflare"], {}), "cloudflare");
  assert.equal(resolveTunnelMode(["--demo", "--public", "cloudflare"], {}), "cloudflare");
});

test("terminalCommand: preserves an explicit --public transport for the forwarded Terminal window", () => {
  assert.match(
    terminalCommand("/a b/node", "/repo/kelly.mjs", true, "boutique", "cloudflare"),
    /'--foreground' '--demo' '--trade' 'boutique' '--public' 'cloudflare'$/,
  );
  assert.match(
    terminalCommand("/a b/node", "/repo/kelly.mjs", false, undefined, "tailscale"),
    /'--foreground' '--public' 'tailscale'$/,
  );
});

test("resolvePublicOrigin: derives https://<KELLY_PUBLIC_HOST> unless KELLY_PUBLIC_ORIGIN is already set", () => {
  assert.equal(resolvePublicOrigin({ KELLY_PUBLIC_HOST: "kelly-test.example.com" }), "https://kelly-test.example.com");
  assert.equal(resolvePublicOrigin({ KELLY_PUBLIC_HOST: "kelly-test.example.com", KELLY_PUBLIC_ORIGIN: "https://already-set.example.com" }), "https://already-set.example.com");
  assert.equal(resolvePublicOrigin({}), undefined);
});

test("maybeKeepAwake: spawns caffeinate -i -w <pid> only on darwin with an active tunnel", () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const spawnProcess = (file: string, args: string[]) => { calls.push({ file, args }); return { fake: true }; };

  assert.equal(maybeKeepAwake("off", true, 4242, { platform: "darwin", spawnProcess }), null);
  assert.equal(calls.length, 0);

  assert.equal(maybeKeepAwake("funnel", false, 4242, { platform: "darwin", spawnProcess }), null);
  assert.equal(calls.length, 0);

  assert.equal(maybeKeepAwake("funnel", true, 4242, { platform: "win32", spawnProcess }), null);
  assert.equal(calls.length, 0);

  const child = maybeKeepAwake("funnel", true, 4242, { platform: "darwin", spawnProcess });
  assert.deepEqual(child, { fake: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/usr/bin/caffeinate");
  assert.deepEqual(calls[0].args, ["-i", "-w", "4242"]);
});
test("readiness requires successful authenticated response", async () => {
  let authorization = "";
  await waitReady("http://127.0.0.1/health", { token: "test-token", fetcher: async (_: unknown, options: {headers: {authorization: string}}) => {
    authorization = options.headers.authorization;
    return new Response("ok");
  } });
  assert.equal(authorization, "Bearer test-token");
});
test("startup fails if service exits or rejects authentication", async () => {
  await assert.rejects(waitReady("http://127.0.0.1", { alive: () => false }), /exited/);
  await assert.rejects(waitReady("http://127.0.0.1", { fetcher: async () => new Response("no", {status:401}) }), /authentication failed/);
});
test("startup refuses an occupied port without stopping its owner", async () => {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await assert.rejects(assertFree((server.address() as net.AddressInfo).port), /already in use/); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Ctrl+C stops both owned service processes", async () => {
  const children: ChildProcess[] = [];
  const command = { file: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] };
  await supervise([command, command], async () => {
    assert.equal(children.length, 2);
    process.emit("SIGINT");
  }, { graceMs: 100, spawnProcess: (...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    children.push(child);
    return child;
  } });
  for (const child of children) assert.throws(() => process.kill(child.pid!, 0), /ESRCH/);
});
