import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error JavaScript launcher intentionally has no build step.
import { shellQuote, terminalCommand, waitReady, assertFree, supervise, resolveTunnelMode, resolvePublicOrigin, maybeKeepAwake, waitForTunnelActive, startKelly } from "../bin/start.mjs";
import net from "node:net";
import { EventEmitter } from "node:events";
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
  assert.equal(resolveTunnelMode(["--public"], { KELLY_CLOUDFLARE_TUNNEL: "shop-demo" }), "cloudflare");
  assert.equal(resolveTunnelMode(["--demo", "--trade", "boutique", "--public"], { KELLY_CLOUDFLARE_TUNNEL: "shop-demo" }), "cloudflare");
  assert.equal(resolveTunnelMode(["--public"], {}), "funnel");
  assert.equal(resolveTunnelMode(["--public"], { KELLY_CLOUDFLARE_TUNNEL: "" }), "funnel");
});

test("resolveTunnelMode: --public cloudflare / --public funnel force one PUBLIC transport regardless of env", () => {
  assert.equal(resolveTunnelMode(["--public", "cloudflare"], { KELLY_CLOUDFLARE_TUNNEL: "kelly" }), "cloudflare");
  assert.equal(resolveTunnelMode(["--public", "funnel"], { KELLY_CLOUDFLARE_TUNNEL: "kelly" }), "funnel");
  assert.equal(resolveTunnelMode(["--public", "cloudflare"], {}), "cloudflare");
  assert.equal(resolveTunnelMode(["--demo", "--public", "cloudflare"], {}), "cloudflare");
});

test("resolveTunnelMode: --private tailscale starts tailnet-only Tailscale Serve, never a public transport", () => {
  assert.equal(resolveTunnelMode(["--private", "tailscale"], {}), "tailscale");
  assert.equal(resolveTunnelMode(["--private", "tailscale"], { KELLY_CLOUDFLARE_TUNNEL: "kelly" }), "tailscale");
  assert.equal(resolveTunnelMode(["--demo", "--private", "tailscale"], {}), "tailscale");
  // There is no --public tailscale spelling any more: an unrecognized forced value under
  // --public simply does not match "cloudflare" or "funnel", so it is not itself a valid
  // way to reach Serve (the CLI layer in startKelly() rejects it outright).
  assert.notEqual(resolveTunnelMode(["--public", "tailscale"], {}), "tailscale");
});

test("terminalCommand: preserves an explicit --public transport or --private tailscale for the forwarded Terminal window", () => {
  assert.match(
    terminalCommand("/a b/node", "/repo/kelly.mjs", true, "boutique", "cloudflare"),
    /'--foreground' '--demo' '--trade' 'boutique' '--public' 'cloudflare'$/,
  );
  assert.match(
    terminalCommand("/a b/node", "/repo/kelly.mjs", true, "boutique", "funnel"),
    /'--foreground' '--demo' '--trade' 'boutique' '--public' 'funnel'$/,
  );
  assert.match(
    terminalCommand("/a b/node", "/repo/kelly.mjs", false, undefined, "private"),
    /'--foreground' '--private' 'tailscale'$/,
  );
});

test("startKelly: rejects the old --public tailscale spelling and points at --private tailscale instead", async () => {
  await assert.rejects(startKelly(["--public", "tailscale"]), /--public accepts only cloudflare or funnel.*--private tailscale/);
});

test("startKelly: rejects an unrecognized --private transport", async () => {
  await assert.rejects(startKelly(["--private", "funnel"]), /--private accepts only tailscale/);
});

test("startKelly: rejects combining --public and --private", async () => {
  await assert.rejects(startKelly(["--public", "--private", "tailscale"]), /either --public or --private tailscale, not both/);
});

test("resolvePublicOrigin: derives https://<KELLY_PUBLIC_HOST> unless KELLY_PUBLIC_ORIGIN is already set", () => {
  assert.equal(resolvePublicOrigin({ KELLY_PUBLIC_HOST: "shop-demo.example.com" }), "https://shop-demo.example.com");
  assert.equal(resolvePublicOrigin({ KELLY_PUBLIC_HOST: "shop-demo.example.com", KELLY_PUBLIC_ORIGIN: "https://already-set.example.com" }), "https://already-set.example.com");
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
test("waitForTunnelActive: polls /api/health until remote.active:true instead of checking once", async () => {
  const calls: string[] = [];
  let call = 0;
  const fetcher = async (url: string) => {
    calls.push(url);
    call++;
    return { json: async () => ({ ok: true, remote: { active: call >= 3 } }) } as Response;
  };
  const active = await waitForTunnelActive("http://127.0.0.1:7338", { fetcher, timeoutMs: 5000, intervalMs: 0 });
  assert.equal(active, true);
  assert.ok(calls.length >= 3);
  assert.equal(calls[0], "http://127.0.0.1:7338/api/health");
});

test("waitForTunnelActive: gives up and returns false once the deadline passes", async () => {
  const fetcher = async () => ({ json: async () => ({ ok: true, remote: { active: false } }) }) as unknown as Response;
  const started = Date.now();
  const active = await waitForTunnelActive("http://127.0.0.1:7338", { fetcher, timeoutMs: 100, intervalMs: 20 });
  assert.equal(active, false);
  assert.ok(Date.now() - started < 2000);
});

test("waitForTunnelActive: a fetch failure (dashboard not answering yet) is swallowed and polling continues", async () => {
  let call = 0;
  const fetcher = async () => {
    call++;
    if (call < 2) throw new Error("ECONNREFUSED");
    return { json: async () => ({ ok: true, remote: { active: true } }) } as unknown as Response;
  };
  const active = await waitForTunnelActive("http://127.0.0.1:7338", { fetcher, timeoutMs: 5000, intervalMs: 0 });
  assert.equal(active, true);
  assert.ok(call >= 2);
});

test("waitForTunnelActive: a health payload missing the remote field is tolerated and polling continues", async () => {
  let call = 0;
  const fetcher = async () => {
    call++;
    // An older dashboard build (or a transient partial response) with no `remote` field at
    // all must not be treated as "active" nor crash the poll — it should just keep waiting.
    if (call < 2) return { json: async () => ({ ok: true }) } as unknown as Response;
    return { json: async () => ({ ok: true, remote: { active: true } }) } as unknown as Response;
  };
  const active = await waitForTunnelActive("http://127.0.0.1:7338", { fetcher, timeoutMs: 5000, intervalMs: 0 });
  assert.equal(active, true);
  assert.ok(call >= 2);
});

test("maybeKeepAwake: caffeinate spawn happens after a delayed connect (waitForTunnelActive result), not the first check", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const spawnProcess = (file: string, args: string[]) => { calls.push({ file, args }); return { fake: true }; };
  let call = 0;
  const fetcher = async () => {
    call++;
    // The tunnel only reports active on the third poll, simulating cloudflared registering a
    // moment after `kelly start` announces the dashboard is ready.
    return { json: async () => ({ ok: true, remote: { active: call >= 3 } }) } as Response;
  };
  const active = await waitForTunnelActive("http://127.0.0.1:7338", { fetcher, timeoutMs: 5000, intervalMs: 0 });
  assert.equal(active, true);
  assert.equal(calls.length, 0); // nothing spawned yet — maybeKeepAwake hasn't been called

  const child = maybeKeepAwake("cloudflare", active, 4242, { platform: "darwin", spawnProcess });
  assert.deepEqual(child, { fake: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/usr/bin/caffeinate");
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

// Fake child processes for supervise(): no real process is ever started (no pid, so the
// shutdown signals are skipped) and each test decides when a "service" exits.
function fakeSpawner() {
  const spawned: Array<{ file: string; args: string[]; child: EventEmitter }> = [];
  const spawnProcess = (file: string, args: string[]) => {
    const child = new EventEmitter();
    spawned.push({ file, args, child });
    return child;
  };
  return { spawned, spawnProcess };
}

test("supervise: a speech worker exit keeps the dashboard running and retries with 5 s doubling to 60 s", async () => {
  const { spawned, spawnProcess } = fakeSpawner();
  const logs: string[] = [];
  const waits: number[] = [];
  let pending: (() => void) | undefined;
  const speech = { file: "node", args: ["voice"], optional: true, label: "Speech", why: "the local voice worker", stillWorks: "Typed chat and quotes still work." };
  const dashboard = { file: "node", args: ["dashboard"] };
  const previousExit = process.exitCode;
  let downDuringReady: boolean | undefined;
  await supervise([speech, dashboard], async (alive: () => boolean, optionalDown: (label: string) => boolean) => {
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const worker = spawned.filter((entry) => entry.args[0] === "voice").at(-1)!;
      worker.child.emit("exit", 1);
      if (attempt === 0) downDuringReady = optionalDown("Speech");
      assert.ok(alive(), "the dashboard must stay up while speech is down");
      assert.ok(pending, "a restart must be scheduled");
      const run = pending!; pending = undefined; run();
    }
    process.emit("SIGINT");
  }, {
    graceMs: 1, spawnProcess, log: (line: string) => logs.push(line), now: () => 0,
    schedule: (fn: () => void, ms: number) => { waits.push(ms); pending = fn; return ms; }, cancel: () => {},
  });
  assert.equal(downDuringReady, true);
  assert.deepEqual(waits, [5000, 10000, 20000, 40000, 60000, 60000, 60000]);
  assert.equal(spawned.filter((entry) => entry.args[0] === "dashboard").length, 1, "the dashboard is never restarted or stopped by a speech failure");
  assert.equal(spawned.filter((entry) => entry.args[0] === "voice").length, 8);
  assert.match(logs[0], /^Speech is unavailable: the local voice worker exited \(1\) \(see its error above\)\. Typed chat and quotes still work\. Retrying in 5 s\.$/);
  assert.ok(logs.every((line) => !/stopping the other service/.test(line)));
  assert.equal(process.exitCode, previousExit);
});

test("supervise: the speech backoff resets after a run that stayed up for the maximum delay", async () => {
  const { spawned, spawnProcess } = fakeSpawner();
  const waits: number[] = [];
  let pending: (() => void) | undefined;
  let clock = 0;
  await supervise([{ file: "node", args: ["voice"], optional: true, label: "Speech" }], async () => {
    for (const upFor of [0, 0, 60_000, 0]) {
      clock += upFor;
      spawned.at(-1)!.child.emit("exit", 1);
      const run = pending!; pending = undefined; run();
    }
    process.emit("SIGINT");
  }, {
    graceMs: 1, spawnProcess, log: () => {}, now: () => clock,
    schedule: (fn: () => void, ms: number) => { waits.push(ms); pending = fn; return ms; }, cancel: () => {},
  });
  assert.deepEqual(waits, [5000, 10000, 5000, 10000]);
});

test("supervise: a failed spawn of the speech worker is retried too, and stop cancels a pending retry", async () => {
  const { spawned, spawnProcess } = fakeSpawner();
  const cancelled: unknown[] = [];
  const logs: string[] = [];
  await supervise([{ file: "node", args: ["voice"], optional: true, label: "Speech" }, { file: "node", args: ["dashboard"] }], async (alive: () => boolean) => {
    spawned[0].child.emit("error", new Error("spawn ENOENT"));
    assert.ok(alive());
    process.emit("SIGINT");
  }, {
    graceMs: 1, spawnProcess, log: (line: string) => logs.push(line), now: () => 0,
    schedule: () => "timer-1", cancel: (timer: unknown) => cancelled.push(timer),
  });
  assert.match(logs[0], /could not start \(spawn ENOENT\)/);
  assert.deepEqual(cancelled, ["timer-1"]);
  assert.equal(spawned.length, 2, "no restart happens after Ctrl+C");
});

test("supervise: the dashboard exiting still stops everything and fails the run", async () => {
  const { spawned, spawnProcess } = fakeSpawner();
  const logs: string[] = [];
  const previousExit = process.exitCode;
  try {
    await supervise([{ file: "node", args: ["voice"], optional: true, label: "Speech" }, { file: "node", args: ["dashboard"] }], async (alive: () => boolean) => {
      spawned[1].child.emit("exit", 1);
      assert.equal(alive(), false);
    }, { graceMs: 1, spawnProcess, log: (line: string) => logs.push(line) });
    assert.equal(process.exitCode, 1);
    assert.match(logs[0], /Kelly service exited \(1\); stopping the other service\./);
  } finally { process.exitCode = previousExit; }
});
