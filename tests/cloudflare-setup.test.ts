import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  validateHostname,
  findCloudflared,
  runCloudflareTunnelSetup,
  runCloudflareTunnelStatus,
  type CloudflareSetupDeps,
} from "../src/remote/cloudflare-setup.ts";

/** In-memory fake filesystem + injectable cloudflared runner, so no real binary or real HOME is ever touched. */
function fakeDeps(overrides: Partial<CloudflareSetupDeps> = {}): { deps: CloudflareSetupDeps; logs: string[]; files: Map<string, string>; calls: Array<{ kind: "run" | "runInherit"; cmd: string; args: string[] }> } {
  const logs: string[] = [];
  const files = new Map<string, string>();
  const calls: Array<{ kind: "run" | "runInherit"; cmd: string; args: string[] }> = [];
  const modes = new Map<string, number>();

  const deps: CloudflareSetupDeps = {
    run: async (cmd, args) => {
      calls.push({ kind: "run", cmd, args });
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    runInherit: async (cmd, args) => {
      calls.push({ kind: "runInherit", cmd, args });
      return { exitCode: 0 };
    },
    fileExists: async (p) => files.has(p),
    readFile: async (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p)!;
    },
    writeFile: async (p, content) => {
      files.set(p, content);
      if (!modes.has(p)) modes.set(p, 0o600);
    },
    chmod: async (p, mode) => {
      modes.set(p, mode);
    },
    resolveDns: async () => ({ cname: false, a: false }),
    env: {},
    homeDir: "/home/fake",
    repoRoot: "/repo/fake",
    log: (line) => logs.push(line),
    ...overrides,
  };
  return { deps, logs, files, calls };
}

// ---------------------------------------------------------------------------
// hostname validation
// ---------------------------------------------------------------------------

test("validateHostname: accepts a plain lowercase DNS hostname", () => {
  assert.equal(validateHostname("shop-demo.example.com"), "shop-demo.example.com");
  assert.equal(validateHostname("example.com"), "example.com");
});

test("validateHostname: rejects a scheme, a path, uppercase, or a bare label", () => {
  assert.throws(() => validateHostname("https://shop-demo.example.com"), /scheme/);
  assert.throws(() => validateHostname("shop-demo.example.com/path"), /path/);
  assert.throws(() => validateHostname("Shop-Demo.example.com"), /lowercase/);
  assert.throws(() => validateHostname("kellytest"), /does not look like a DNS hostname/);
  assert.throws(() => validateHostname(""), /Usage: kelly tunnel setup/);
});

// ---------------------------------------------------------------------------
// finding cloudflared
// ---------------------------------------------------------------------------

test("findCloudflared: missing cloudflared surfaces a clear brew-install message", async () => {
  const { deps } = fakeDeps({ env: { PATH: "/usr/bin" } });
  const found = await findCloudflared(deps);
  assert.equal(found, undefined);
  await assert.rejects(
    runCloudflareTunnelSetup("shop-demo.example.com", {}, deps),
    /brew install cloudflared/,
  );
});

test("findCloudflared: KELLY_CLOUDFLARED_PATH wins, then PATH, then the Homebrew fallbacks", async () => {
  const { deps: viaEnv } = fakeDeps({
    env: { KELLY_CLOUDFLARED_PATH: "/custom/cloudflared" },
    fileExists: async (p) => p === "/custom/cloudflared",
  });
  assert.equal(await findCloudflared(viaEnv), "/custom/cloudflared");

  const { deps: viaPath } = fakeDeps({
    env: { PATH: "/usr/local/bin:/usr/bin" },
    fileExists: async (p) => p === "/usr/local/bin/cloudflared",
  });
  assert.equal(await findCloudflared(viaPath), "/usr/local/bin/cloudflared");

  const { deps: viaFallback } = fakeDeps({
    env: { PATH: "/usr/bin" },
    fileExists: async (p) => p === "/opt/homebrew/bin/cloudflared",
  });
  assert.equal(await findCloudflared(viaFallback), "/opt/homebrew/bin/cloudflared");
});

// ---------------------------------------------------------------------------
// login step
// ---------------------------------------------------------------------------

test("setup: login is skipped when cert.pem already exists", async () => {
  const certPath = path.join("/home/fake", ".cloudflared", "cert.pem");
  const { deps, calls } = fakeDeps({
    env: { PATH: "/usr/bin" },
    fileExists: async (p) => p === "/usr/bin/cloudflared" || p === certPath,
    run: async (_cmd, args) => {
      if (args[0] === "tunnel" && args[1] === "list") return { stdout: "[]", stderr: "", exitCode: 0 };
      if (args[0] === "tunnel" && args[1] === "create") return { stdout: "Created tunnel shop-demo with id aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n", stderr: "", exitCode: 0 };
      if (args[0] === "tunnel" && args[1] === "route") return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });
  await runCloudflareTunnelSetup("shop-demo.example.com", {}, deps);
  assert.equal(calls.some((c) => c.kind === "runInherit"), false);
});

test("setup: login runs with inherited stdio when cert.pem is absent", async () => {
  const { deps, calls } = fakeDeps({
    env: { PATH: "/usr/bin" },
    fileExists: async (p) => p === "/usr/bin/cloudflared",
    run: async (_cmd, args) => {
      if (args[0] === "tunnel" && args[1] === "list") return { stdout: "[]", stderr: "", exitCode: 0 };
      if (args[0] === "tunnel" && args[1] === "create") return { stdout: "Created tunnel shop-demo with id aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n", stderr: "", exitCode: 0 };
      if (args[0] === "tunnel" && args[1] === "route") return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });
  await runCloudflareTunnelSetup("shop-demo.example.com", {}, deps);
  const loginCall = calls.find((c) => c.kind === "runInherit");
  assert.ok(loginCall, "expected cloudflared tunnel login to run with inherited stdio");
  assert.deepEqual(loginCall!.args, ["tunnel", "login"]);
});

// ---------------------------------------------------------------------------
// tunnel create / reuse
// ---------------------------------------------------------------------------

test("setup: an existing tunnel with the requested name is reused, not recreated", async () => {
  const certPath = path.join("/home/fake", ".cloudflared", "cert.pem");
  const { deps, calls } = fakeDeps({
    env: { PATH: "/usr/bin" },
    fileExists: async (p) => p === "/usr/bin/cloudflared" || p === certPath,
    run: async (_cmd, args) => {
      if (args[0] === "tunnel" && args[1] === "list") {
        return { stdout: JSON.stringify([{ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "shop-demo" }]), stderr: "", exitCode: 0 };
      }
      if (args[0] === "tunnel" && args[1] === "route") return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });
  await runCloudflareTunnelSetup("shop-demo.example.com", {}, deps);
  assert.equal(calls.some((c) => c.args[0] === "tunnel" && c.args[1] === "create"), false);
});

// ---------------------------------------------------------------------------
// DNS route conflicts
// ---------------------------------------------------------------------------

test("setup: a DNS route already used by something else stops with a clear message", async () => {
  const certPath = path.join("/home/fake", ".cloudflared", "cert.pem");
  const { deps } = fakeDeps({
    env: { PATH: "/usr/bin" },
    fileExists: async (p) => p === "/usr/bin/cloudflared" || p === certPath,
    run: async (_cmd, args) => {
      if (args[0] === "tunnel" && args[1] === "list") {
        return { stdout: JSON.stringify([{ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "shop-demo" }]), stderr: "", exitCode: 0 };
      }
      if (args[0] === "tunnel" && args[1] === "route") {
        return { stdout: "", stderr: "failed to add route: record with that host already exists", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });
  await assert.rejects(
    runCloudflareTunnelSetup("shop-demo.example.com", {}, deps),
    /already routed to something else.*Cloudflare dashboard|choose a different hostname/s,
  );
});

test("setup: a DNS route already pointing at this tunnel is treated as fine", async () => {
  const certPath = path.join("/home/fake", ".cloudflared", "cert.pem");
  const tunnelId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const { deps } = fakeDeps({
    env: { PATH: "/usr/bin" },
    fileExists: async (p) => p === "/usr/bin/cloudflared" || p === certPath,
    run: async (_cmd, args) => {
      if (args[0] === "tunnel" && args[1] === "list") {
        return { stdout: JSON.stringify([{ id: tunnelId, name: "kelly" }]), stderr: "", exitCode: 0 };
      }
      if (args[0] === "tunnel" && args[1] === "route") {
        return { stdout: "", stderr: `record with that host already exists, pointing at ${tunnelId}.cfargotunnel.com`, exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });
  await runCloudflareTunnelSetup("shop-demo.example.com", {}, deps);
});

// ---------------------------------------------------------------------------
// .env writing
// ---------------------------------------------------------------------------

test("setup: writes .env keeping other lines, replacing existing keys, with a .env.bak and mode 0600", async () => {
  const certPath = path.join("/home/fake", ".cloudflared", "cert.pem");
  const envPath = "/repo/fake/.env";
  const backupPath = "/repo/fake/.env.bak";
  const { deps, files } = fakeDeps({
    env: { PATH: "/usr/bin" },
    fileExists: async (p) => p === "/usr/bin/cloudflared" || p === certPath || p === envPath,
    run: async (_cmd, args) => {
      if (args[0] === "tunnel" && args[1] === "list") return { stdout: "[]", stderr: "", exitCode: 0 };
      if (args[0] === "tunnel" && args[1] === "create") return { stdout: "Created tunnel shop-demo with id aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n", stderr: "", exitCode: 0 };
      if (args[0] === "tunnel" && args[1] === "route") return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });
  files.set(envPath, "KELLY_TRADE=boutique\nKELLY_TUNNEL=off\nKELLY_PORT=7338\n");
  const chmodCalls: Array<{ path: string; mode: number }> = [];
  deps.chmod = async (p, mode) => { chmodCalls.push({ path: p, mode }); };

  await runCloudflareTunnelSetup("shop-demo.example.com", { name: "shop-demo" }, deps);

  const updated = files.get(envPath)!;
  assert.match(updated, /KELLY_TRADE=boutique/);
  assert.match(updated, /KELLY_PORT=7338/);
  assert.match(updated, /KELLY_TUNNEL=cloudflare/);
  assert.doesNotMatch(updated, /KELLY_TUNNEL=off/);
  assert.match(updated, /KELLY_CLOUDFLARE_TUNNEL=shop-demo/);
  assert.match(updated, /KELLY_PUBLIC_HOST=shop-demo\.example\.com/);
  assert.equal(files.get(backupPath), "KELLY_TRADE=boutique\nKELLY_TUNNEL=off\nKELLY_PORT=7338\n");
  assert.ok(chmodCalls.some((c) => c.path === envPath && c.mode === 0o600));
});

// ---------------------------------------------------------------------------
// --status
// ---------------------------------------------------------------------------

test("status: never prints cert.pem contents, only presence", async () => {
  const certPath = path.join("/home/fake", ".cloudflared", "cert.pem");
  const envPath = "/repo/fake/.env";
  const secretCertContents = "-----BEGIN PRIVATE KEY super secret-----";
  const { deps, logs } = fakeDeps({
    env: { PATH: "/usr/bin" },
    fileExists: async (p) => p === "/usr/bin/cloudflared" || p === certPath || p === envPath,
    readFile: async (p) => {
      if (p === certPath) return secretCertContents;
      if (p === envPath) return "KELLY_CLOUDFLARE_TUNNEL=shop-demo\nKELLY_PUBLIC_HOST=shop-demo.example.com\n";
      throw new Error(`ENOENT: ${p}`);
    },
    run: async (_cmd, args) => {
      if (args[0] === "tunnel" && args[1] === "list") {
        return { stdout: JSON.stringify([{ id: "abc", name: "shop-demo" }]), stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    resolveDns: async () => ({ cname: true, a: false }),
  });

  const report = await runCloudflareTunnelStatus(deps);
  assert.equal(report.certPresent, true);
  assert.equal(report.tunnelExists, true);
  assert.equal(report.publicHost, "shop-demo.example.com");
  assert.equal(report.dns.cname, true);

  const combined = logs.join("\n");
  assert.doesNotMatch(combined, /BEGIN PRIVATE KEY/);
  assert.doesNotMatch(combined, /super secret/);
});

// ---------------------------------------------------------------------------
// real filesystem integration for the .env write (temp HOME + temp repo root)
// ---------------------------------------------------------------------------

test("setup + status: end-to-end against a temp HOME and a temp repo root", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "kelly-cf-home-"));
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kelly-cf-repo-"));
  try {
    const { deps } = fakeDeps({
      env: { PATH: "/usr/bin" },
      homeDir,
      repoRoot,
      fileExists: async (p) => p === "/usr/bin/cloudflared" || (await fs.stat(p).then(() => true, () => false)),
      readFile: (p) => fs.readFile(p, "utf8"),
      writeFile: (p, content) => fs.writeFile(p, content, { mode: 0o600 }),
      chmod: (p, mode) => fs.chmod(p, mode),
      run: async (_cmd, args) => {
        if (args[0] === "tunnel" && args[1] === "list") return { stdout: "[]", stderr: "", exitCode: 0 };
        if (args[0] === "tunnel" && args[1] === "create") return { stdout: "Created tunnel shop-demo with id aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n", stderr: "", exitCode: 0 };
        if (args[0] === "tunnel" && args[1] === "route") return { stdout: "", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    await runCloudflareTunnelSetup("shop-demo.example.com", {}, deps);

    const envPath = path.join(repoRoot, ".env");
    const content = await fs.readFile(envPath, "utf8");
    assert.match(content, /KELLY_TUNNEL=cloudflare/);
    assert.match(content, /KELLY_CLOUDFLARE_TUNNEL=kelly/);
    assert.match(content, /KELLY_PUBLIC_HOST=shop-demo\.example\.com/);
    const stat = await fs.stat(envPath);
    assert.equal(stat.mode & 0o777, 0o600);

    const status = await runCloudflareTunnelStatus(deps);
    assert.equal(status.publicHost, "shop-demo.example.com");
    assert.equal(status.tunnelName, "kelly");
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});
