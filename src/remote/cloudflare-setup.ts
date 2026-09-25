import path from "node:path";
import os from "node:os";
import dns from "node:dns/promises";
import fsp from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/**
 * `kelly tunnel setup <hostname>`: a one-time, idempotent setup flow for putting Kelly on the
 * owner's own Cloudflare domain (`https://kelly.<domain>`), instead of Tailscale Funnel.
 * Every external call (cloudflared, DNS resolution, filesystem) goes through the injected
 * CloudflareSetupDeps so tests never spawn the real `cloudflared` binary or touch a real HOME.
 *
 * This module never reads the contents of `~/.cloudflared/cert.pem` or any credentials JSON —
 * only whether such a file exists.
 */

export interface CloudflareRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface CloudflareSetupDeps {
  /** Runs a cloudflared subcommand and captures stdout/stderr (never inherits the terminal). */
  run: (cmd: string, args: string[]) => Promise<CloudflareRunResult>;
  /** Runs a cloudflared subcommand with inherited stdio (used only for `tunnel login`, which
   *  opens a browser and needs the owner's terminal). */
  runInherit: (cmd: string, args: string[]) => Promise<{ exitCode: number | null }>;
  fileExists: (filePath: string) => Promise<boolean>;
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  chmod: (filePath: string, mode: number) => Promise<void>;
  /** CNAME/A presence only, with a short timeout; never throws on lookup failure. */
  resolveDns: (hostname: string) => Promise<{ cname: boolean; a: boolean }>;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  repoRoot: string;
  log: (line: string) => void;
}

export interface CloudflareStatusReport {
  cloudflaredInstalled: boolean;
  cloudflaredPath?: string;
  certPresent: boolean;
  tunnelName?: string;
  tunnelExists: boolean;
  publicHost?: string;
  dns: { cname: boolean; a: boolean };
}

const DNS_TIMEOUT_MS = 3_000;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Lowercase DNS hostname, no scheme, no path, at least one dot (e.g. `kelly.example.com`). */
export function validateHostname(raw: string): string {
  const hostname = (raw ?? "").trim();
  if (!hostname) throw new Error("Usage: kelly tunnel setup <hostname> [--name kelly]");
  if (hostname.includes("://")) throw new Error(`Hostname must not include a scheme (http:// or https://): ${hostname}`);
  if (hostname.includes("/")) throw new Error(`Hostname must not include a path: ${hostname}`);
  if (hostname !== hostname.toLowerCase()) throw new Error(`Hostname must be lowercase: ${hostname}`);
  const pattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (!pattern.test(hostname)) {
    throw new Error(`"${hostname}" does not look like a DNS hostname, e.g. kelly.example.com`);
  }
  return hostname;
}

async function existsOnPath(deps: CloudflareSetupDeps, binary: string): Promise<string | undefined> {
  if (binary.includes(path.sep)) {
    return (await deps.fileExists(binary)) ? binary : undefined;
  }
  const dirs = (deps.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, binary);
    if (await deps.fileExists(candidate)) return candidate;
  }
  return undefined;
}

/** KELLY_CLOUDFLARED_PATH, then PATH, then the two common Homebrew install locations. */
export async function findCloudflared(deps: CloudflareSetupDeps): Promise<string | undefined> {
  const custom = deps.env.KELLY_CLOUDFLARED_PATH?.trim();
  if (custom) {
    const resolved = await existsOnPath(deps, custom);
    if (resolved) return resolved;
  }
  const onPath = await existsOnPath(deps, "cloudflared");
  if (onPath) return onPath;
  for (const candidate of ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"]) {
    if (await deps.fileExists(candidate)) return candidate;
  }
  return undefined;
}

function certPath(deps: CloudflareSetupDeps): string {
  return path.join(deps.homeDir, ".cloudflared", "cert.pem");
}

async function ensureLogin(cloudflaredPath: string, deps: CloudflareSetupDeps): Promise<void> {
  const cert = certPath(deps);
  if (await deps.fileExists(cert)) {
    deps.log("Cloudflare login: already authenticated (cert.pem found). Skipping.");
    return;
  }
  deps.log("Cloudflare login: opening a browser so you can pick the domain. Waiting for it to finish...");
  const result = await deps.runInherit(cloudflaredPath, ["tunnel", "login"]);
  if (result.exitCode !== 0) {
    throw new Error(
      `cloudflared tunnel login did not finish successfully (exit code ${String(result.exitCode)}). ` +
        "Run `kelly tunnel setup <hostname>` again once you have picked a domain in the browser.",
    );
  }
}

interface TunnelListEntry {
  id?: string;
  name?: string;
}

function parseTunnelList(stdout: string): TunnelListEntry[] {
  try {
    const parsed = JSON.parse(stdout || "[]");
    return Array.isArray(parsed) ? (parsed as TunnelListEntry[]) : [];
  } catch {
    return [];
  }
}

async function ensureTunnel(cloudflaredPath: string, name: string, deps: CloudflareSetupDeps): Promise<string | undefined> {
  deps.log(`Checking for an existing tunnel named "${name}"...`);
  const listResult = await deps.run(cloudflaredPath, ["tunnel", "list", "--output", "json"]);
  const existing = parseTunnelList(listResult.stdout).find((entry) => entry.name === name);
  if (existing) {
    deps.log(`Tunnel "${name}" already exists${existing.id ? ` (${existing.id})` : ""}. Skipping creation.`);
    return existing.id;
  }
  deps.log(`Creating tunnel "${name}"...`);
  const createResult = await deps.run(cloudflaredPath, ["tunnel", "create", name]);
  if (createResult.exitCode !== 0) {
    throw new Error(`cloudflared tunnel create failed: ${createResult.stderr || createResult.stdout || `exit code ${String(createResult.exitCode)}`}`);
  }
  const combined = `${createResult.stdout}\n${createResult.stderr}`;
  const match = combined.match(UUID_PATTERN);
  return match ? match[0] : undefined;
}

async function ensureDnsRoute(cloudflaredPath: string, name: string, hostname: string, tunnelId: string | undefined, deps: CloudflareSetupDeps): Promise<void> {
  deps.log(`Routing ${hostname} to tunnel "${name}"...`);
  const result = await deps.run(cloudflaredPath, ["tunnel", "route", "dns", name, hostname]);
  if (result.exitCode === 0) {
    deps.log(`DNS route created: ${hostname} -> ${name}`);
    return;
  }
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  const conflict = text.includes("already exist") || text.includes("already configured") || text.includes("already has");
  if (conflict) {
    const pointsAtThisTunnel = Boolean(tunnelId) && text.includes(tunnelId!.toLowerCase());
    if (pointsAtThisTunnel) {
      deps.log(`DNS route already points at "${name}". Skipping.`);
      return;
    }
    throw new Error(
      `${hostname} is already routed to something else in Cloudflare DNS. Delete that DNS record in the ` +
        "Cloudflare dashboard, or choose a different hostname, then run `kelly tunnel setup` again.",
    );
  }
  throw new Error(`cloudflared tunnel route dns failed: ${result.stderr || result.stdout || `exit code ${String(result.exitCode)}`}`);
}

/** update-or-append into the repo's .env: never removes other lines, keeps a .env.bak copy first, preserves 0600. */
async function writeEnvUpdates(deps: CloudflareSetupDeps, updates: Record<string, string>): Promise<void> {
  const envPath = path.join(deps.repoRoot, ".env");
  const backupPath = path.join(deps.repoRoot, ".env.bak");
  const existing = (await deps.fileExists(envPath)) ? await deps.readFile(envPath) : "";
  await deps.writeFile(backupPath, existing);

  const lines = existing.length ? existing.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const seen = new Set<string>();
  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match && Object.prototype.hasOwnProperty.call(updates, match[1])) {
      seen.add(match[1]);
      return `${match[1]}=${updates[match[1]]}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) nextLines.push(`${key}=${value}`);
  }
  await deps.writeFile(envPath, `${nextLines.join("\n")}\n`);
  await deps.chmod(envPath, 0o600);
}

export interface CloudflareTunnelSetupOptions {
  name?: string;
}

/** Runs the full idempotent setup flow described in docs/modules/remote-access.md. */
export async function runCloudflareTunnelSetup(rawHostname: string, options: CloudflareTunnelSetupOptions, deps: CloudflareSetupDeps): Promise<void> {
  const hostname = validateHostname(rawHostname);
  const name = options.name?.trim() || "kelly";

  const cloudflaredPath = await findCloudflared(deps);
  if (!cloudflaredPath) {
    throw new Error("cloudflared was not found. Install it first:\n  brew install cloudflared");
  }

  await ensureLogin(cloudflaredPath, deps);
  const tunnelId = await ensureTunnel(cloudflaredPath, name, deps);
  await ensureDnsRoute(cloudflaredPath, name, hostname, tunnelId, deps);
  await writeEnvUpdates(deps, {
    KELLY_TUNNEL: "cloudflare",
    KELLY_CLOUDFLARE_TUNNEL: name,
    KELLY_PUBLIC_HOST: hostname,
  });

  deps.log("");
  deps.log("Kelly is configured for your own domain. Next:");
  deps.log("  kelly users add owner --role admin --demo boutique");
  deps.log("  kelly users add counter --role counter --demo boutique");
  deps.log("  kelly start --demo --trade boutique --public");
  deps.log(`Link: https://${hostname}`);
}

/** `kelly tunnel setup --status`: never prints cert.pem contents, only whether it exists. */
export async function runCloudflareTunnelStatus(deps: CloudflareSetupDeps): Promise<CloudflareStatusReport> {
  const cloudflaredPath = await findCloudflared(deps);
  const certPresent = await deps.fileExists(certPath(deps));

  const envPath = path.join(deps.repoRoot, ".env");
  const envContent = (await deps.fileExists(envPath)) ? await deps.readFile(envPath) : "";
  const parsed = dotenv.parse(envContent);
  const tunnelName = parsed.KELLY_CLOUDFLARE_TUNNEL || undefined;
  const publicHost = parsed.KELLY_PUBLIC_HOST || undefined;

  let tunnelExists = false;
  if (cloudflaredPath && tunnelName) {
    const listResult = await deps.run(cloudflaredPath, ["tunnel", "list", "--output", "json"]);
    tunnelExists = parseTunnelList(listResult.stdout).some((entry) => entry.name === tunnelName);
  }

  const dnsResult = publicHost ? await deps.resolveDns(publicHost) : { cname: false, a: false };

  const report: CloudflareStatusReport = {
    cloudflaredInstalled: Boolean(cloudflaredPath),
    cloudflaredPath,
    certPresent,
    tunnelName,
    tunnelExists,
    publicHost,
    dns: dnsResult,
  };

  deps.log(`cloudflared: ${report.cloudflaredInstalled ? `installed (${report.cloudflaredPath})` : "not found"}`);
  deps.log(`Cloudflare login (cert.pem): ${certPresent ? "present" : "missing"}`);
  deps.log(`Tunnel: ${tunnelName ? `${tunnelName} (${tunnelExists ? "exists" : "not found"})` : "(KELLY_CLOUDFLARE_TUNNEL not set)"}`);
  deps.log(`KELLY_PUBLIC_HOST: ${publicHost ?? "(not set)"}`);
  deps.log(`DNS: ${publicHost ? `${dnsResult.cname ? "CNAME present" : "no CNAME"}, ${dnsResult.a ? "A present" : "no A"}` : "n/a"}`);

  return report;
}

async function resolveDnsDefault(hostname: string): Promise<{ cname: boolean; a: boolean }> {
  const withTimeout = async <T>(promise: Promise<T>): Promise<T | undefined> => {
    try {
      return await Promise.race([
        promise,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), DNS_TIMEOUT_MS)),
      ]);
    } catch {
      return undefined;
    }
  };
  const [cname, a] = await Promise.all([
    withTimeout(dns.resolveCname(hostname)).then((result) => Boolean(result && result.length), () => false),
    withTimeout(dns.resolve4(hostname)).then((result) => Boolean(result && result.length), () => false),
  ]);
  return { cname, a };
}

function spawnCaptured(cmd: string, args: string[]): Promise<CloudflareRunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: null });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr += String(chunk); });
    child.once("error", (error: Error) => resolve({ stdout, stderr: stderr || error.message, exitCode: null }));
    child.once("close", (code: number | null) => resolve({ stdout, stderr, exitCode: code }));
  });
}

function spawnInherited(cmd: string, args: string[]): Promise<{ exitCode: number | null }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { shell: false, stdio: "inherit" });
    } catch {
      resolve({ exitCode: null });
      return;
    }
    child.once("error", () => resolve({ exitCode: null }));
    child.once("close", (code: number | null) => resolve({ exitCode: code }));
  });
}

/** Real deps for the CLI: spawns the actual `cloudflared` binary, real filesystem, real DNS. */
export function createDefaultCloudflareSetupDeps(): CloudflareSetupDeps {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  return {
    run: spawnCaptured,
    runInherit: spawnInherited,
    fileExists: async (filePath) => {
      try {
        await fsp.access(filePath, fsConstants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    readFile: (filePath) => fsp.readFile(filePath, "utf8"),
    writeFile: (filePath, content) => fsp.writeFile(filePath, content, { mode: 0o600 }),
    chmod: (filePath, mode) => fsp.chmod(filePath, mode),
    resolveDns: resolveDnsDefault,
    env: process.env,
    homeDir: os.homedir(),
    repoRoot,
    log: (line) => console.log(line),
  };
}
