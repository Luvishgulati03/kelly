import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error JavaScript launcher intentionally has no build step.
import { shellQuote, terminalCommand, waitReady, assertFree, supervise } from "../bin/start.mjs";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

test("terminal launch quotes paths and preserves demo mode", () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.match(terminalCommand("/a b/node", "/repo/kelly.mjs", true), /'--foreground' '--demo'$/);
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
