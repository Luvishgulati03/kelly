import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import net from "node:net";
import dotenv from "dotenv";
import crypto from "node:crypto";
import { constants } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(root, "bin/kelly.mjs");
export const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

export function terminalCommand(node, entry, demo = false, trade, publicFlag = false) {
  const publicArgs = publicFlag === "tailscale" || publicFlag === "cloudflare" ? ["--public", publicFlag] : publicFlag ? ["--public"] : [];
  return [node, entry, "start", "--foreground", ...(demo ? ["--demo"] : []), ...(trade ? ["--trade", trade] : []), ...publicArgs].map(shellQuote).join(" ");
}

/**
 * `--public` (with or without `--demo`) turns on a public tunnel; otherwise the tunnel stays
 * off, as today. `--public tailscale` / `--public cloudflare` force one transport. Bare
 * `--public` picks Cloudflare when the effective env (process env plus the repo .env this
 * launcher already loads) has KELLY_CLOUDFLARE_TUNNEL configured (see `kelly tunnel setup`),
 * otherwise Tailscale Funnel.
 */
export function resolveTunnelMode(args, env = process.env) {
  const index = args.indexOf("--public");
  if (index === -1) return "off";
  const forced = args[index + 1];
  if (forced === "tailscale" || forced === "cloudflare") return forced;
  return env.KELLY_CLOUDFLARE_TUNNEL ? "cloudflare" : "funnel";
}

/**
 * The dashboard server trusts KELLY_PUBLIC_ORIGIN for same-origin checks. Derived from
 * KELLY_PUBLIC_HOST (set by `kelly tunnel setup`) unless the environment already set one.
 */
export function resolvePublicOrigin(env = process.env) {
  if (env.KELLY_PUBLIC_ORIGIN) return env.KELLY_PUBLIC_ORIGIN;
  return env.KELLY_PUBLIC_HOST ? `https://${env.KELLY_PUBLIC_HOST}` : undefined;
}

/**
 * Spawns `caffeinate -i -w <pid>` so this Mac cannot idle-sleep while a tunnel is online;
 * caffeinate exits on its own once the watched pid exits, so nothing lingers after Ctrl+C.
 * Only for darwin, and only when a tunnel is actually active (not merely configured) — the
 * spawner is injectable so tests never start a real process. Display sleep is untouched.
 */
export function maybeKeepAwake(tunnelMode, remoteActive, pid, options = {}) {
  const platform = options.platform || process.platform;
  if (tunnelMode === "off" || !remoteActive || platform !== "darwin") return null;
  const spawnProcess = options.spawnProcess || spawn;
  const child = spawnProcess("/usr/bin/caffeinate", ["-i", "-w", String(pid)], { stdio: "ignore" });
  console.log("Keeping this Mac awake while Kelly is online.");
  return child;
}

export async function assertFree(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", () => reject(new Error(`Port ${port} is already in use. Stop the existing service before running kelly start.`)));
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}

export async function waitReady(url, options = {}) {
  const { token, timeoutMs = 60000, fetcher = fetch, alive = () => true } = options;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive()) throw new Error("A Kelly service exited during startup. See its error above.");
    try {
      const response = await fetcher(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(1500), redirect: "error",
      });
      await response.body?.cancel();
      if (response.ok) return;
      if (response.status === 401 || response.status === 403) throw new Error("Worker authentication failed; check Kelly's local token configuration.");
    } catch (error) {
      if (error.message.startsWith("Worker authentication")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Kelly startup timed out. Check the service output and local voice configuration.");
}

export async function supervise(commands, ready, options = {}) {
  const children = [];
  const launch = options.spawnProcess || spawn;
  let stopping = false;
  let finish;
  const ended = new Promise((resolve) => { finish = resolve; });
  const signal = (child, sig) => {
    if (!child.pid) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch { /* Already stopped. Never target unrelated processes. */ }
  };
  const stop = async (failed = false) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) signal(child, "SIGTERM");
    // Include grandchildren such as the Python speech worker in shutdown.
    await new Promise((resolve) => setTimeout(resolve, options.graceMs ?? 1500));
    for (const child of children) signal(child, "SIGKILL");
    if (failed) process.exitCode = 1;
    finish();
  };
  const onSignal = () => { void stop(); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);
  try {
    for (const command of commands) {
      const child = launch(command.file, command.args, {
        cwd: root, env: options.env || process.env, shell: false,
        detached: process.platform !== "win32", stdio: ["ignore", "inherit", "inherit"],
      });
      children.push(child);
      child.once("error", (error) => { console.error(`Kelly service could not start: ${error.message}`); void stop(true); });
      child.once("exit", (code) => {
        if (!stopping) { console.error(`Kelly service exited (${code ?? "signal"}); stopping the other service.`); void stop(true); }
      });
    }
    await ready(() => !stopping);
    await ended;
  } catch (error) {
    await stop(true);
    throw error;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGHUP", onSignal);
  }
}

export async function startKelly(args) {
  if (args.includes("--help")) {
    console.log("kelly start: dashboard + local voice in a new macOS Terminal window.\nkelly start --foreground: run both here; Ctrl+C stops both.\nkelly start --demo: isolated fictional catalogue on a local port.\nkelly start --demo --trade boutique|electrical: pick the demo trade pack (default electrical).\nkelly start [--demo] --public: turns on a public tunnel so the link is reachable by anyone — Cloudflare (your own domain, see `kelly tunnel setup <hostname>`) when KELLY_CLOUDFLARE_TUNNEL is configured, otherwise Tailscale Funnel; keeps this Mac awake while it runs. Requires an admin account (kelly users add <name> --role admin [--demo <trade>]).\nkelly start --public tailscale|cloudflare: force one tunnel transport instead of the automatic choice.\nUses Kelly's repository .env. No downloads. Without --public, remote tunnels are disabled.");
    return;
  }
  const tradeIndex = args.indexOf("--trade");
  const trade = tradeIndex === -1 ? undefined : args[tradeIndex + 1];
  let knownFlags = tradeIndex === -1 ? args : [...args.slice(0, tradeIndex), ...args.slice(tradeIndex + 2)];
  const publicIndexInArgs = args.indexOf("--public");
  const publicValueRaw = publicIndexInArgs === -1 ? undefined : args[publicIndexInArgs + 1];
  const publicValue = publicValueRaw === "tailscale" || publicValueRaw === "cloudflare" ? publicValueRaw : undefined;
  if (publicValue) {
    const publicIndexInKnown = knownFlags.indexOf("--public");
    knownFlags = [...knownFlags.slice(0, publicIndexInKnown + 1), ...knownFlags.slice(publicIndexInKnown + 2)];
  }
  if (knownFlags.some((arg) => !["--foreground", "--demo", "--public"].includes(arg))) throw new Error("Usage: kelly start [--foreground] [--demo] [--trade boutique|electrical] [--public [tailscale|cloudflare]]");
  if (trade !== undefined && !args.includes("--demo")) throw new Error("--trade is only valid with --demo.");
  if (trade !== undefined && !["boutique", "electrical"].includes(trade)) throw new Error("--trade must be boutique or electrical.");
  if (process.platform === "darwin" && !args.includes("--foreground")) {
    const script = 'on run argv\ntell application "Terminal"\nactivate\ndo script (item 1 of argv)\nend tell\nend run';
    await new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/osascript", ["-e", script, terminalCommand(process.execPath, launcher, args.includes("--demo"), trade, publicValue || args.includes("--public"))], { shell: false, stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Could not open Terminal. Run kelly start --foreground instead.")));
    });
    console.log("Opened Kelly's service window. It will print the dashboard and voice URLs when ready.");
    return;
  }
  dotenv.config({ path: path.join(root, ".env"), quiet: true });
  // Reuse explicitly installed local assets. Never download or alter saved settings.
  const localDefaults = {
    KELLY_KOKORO_MODEL_PATH: path.join(root, "data/voice/models/kokoro-v1.0.int8.onnx"),
    KELLY_KOKORO_VOICES_PATH: path.join(root, "data/voice/models/voices-v1.0.bin"),
    KELLY_WHISPER_MODEL_PATH: path.join(root, "data/voice/models/ggml-small-q5_1.bin"),
  };
  for (const [key, value] of Object.entries(localDefaults)) {
    if (!process.env[key] && (await fs.stat(value).catch(() => null))?.isFile()) process.env[key] = value;
  }
  if (!process.env.KELLY_WHISPER_CPP_PATH) {
    for (const directory of (process.env.PATH || "").split(path.delimiter)) {
      if (!directory) continue;
      const candidate = path.join(directory, "whisper-cli");
      if (await fs.access(candidate, constants.X_OK).then(() => true, () => false)) {
        process.env.KELLY_WHISPER_CPP_PATH = candidate;
        break;
      }
    }
  }
  process.env.KELLY_KOKORO_URL ||= "http://127.0.0.1:8765";
  process.env.KELLY_KOKORO_TOKEN ||= crypto.randomBytes(32).toString("hex");
  process.env.KELLY_TTS_ENGINE ||= "kokoro";
  if (args.includes("--demo")) {
    const isBoutique = trade === "boutique";
    const demoRoot = path.join(root, "data", isBoutique ? "demo-boutique" : "demo");
    for (const sub of ["data", "memory", "knowledge"]) {
      await fs.mkdir(path.join(demoRoot, sub), { recursive: true });
    }
    Object.assign(process.env, {
      KELLY_DATA_DIR: path.join(demoRoot, "data"),
      KELLY_MEMORY_DIR: path.join(demoRoot, "memory"),
      KELLY_KNOWLEDGE_DIR: path.join(demoRoot, "knowledge"),
      KELLY_PORT: process.env.KELLY_PORT || "7338",
      KELLY_TRADE: isBoutique ? "boutique" : "electrical",
    });
    if (isBoutique) process.env.KELLY_SHOP_NAME = "She Fashion House";
    // Demo mode never connects to the real owner's Telegram account.
    process.env.KELLY_TELEGRAM_BOT_TOKEN = "";
    process.env.HENRY_TELEGRAM_BOT_TOKEN = "";
    console.log(isBoutique
      ? `DEMO MODE: She Fashion House boutique, separate data and memory, port ${process.env.KELLY_PORT}.`
      : `DEMO MODE: fictional catalogue, separate data and memory, port ${process.env.KELLY_PORT}.`);
  }
  const { loadConfig } = await import("../src/config.ts");
  // Avoid reading another project's .env when launched from an arbitrary directory.
  process.chdir(root);
  const config = loadConfig();
  if (args.includes("--demo") && config.commerceEnabled) {
    const { seedDemoCatalogueIfEmpty } = await import("../src/commerce/demo-seed.ts");
    const { seeded } = await seedDemoCatalogueIfEmpty(config);
    if (seeded) console.log(`Seeded the demo ${config.trade} ${config.trade === "boutique" ? "rate card" : "catalogue"}.`);
  }
  if (args.includes("--demo") && config.trade === "boutique") {
    const { DesignService } = await import("../src/designs/rag.ts");
    const { seedBoutiqueDesigns } = await import("../src/designs/seed.ts");
    const { boutiqueTradePack } = await import("../src/trade/boutique.ts");
    const designs = new DesignService(config, boutiqueTradePack.galleryCategories, boutiqueTradePack.galleryTags);
    try {
      const { seeded } = await seedBoutiqueDesigns(designs);
      if (seeded) console.log(`Seeded ${seeded} demo boutique designs.`);
    } finally { designs.close(); }
  }
  const voiceUrl = new URL(process.env.KELLY_KOKORO_URL || "http://127.0.0.1:8765");
  if (voiceUrl.protocol !== "http:" || voiceUrl.hostname !== "127.0.0.1" || voiceUrl.username || voiceUrl.password || voiceUrl.pathname !== "/" || voiceUrl.search || voiceUrl.hash) {
    throw new Error("For kelly start, set KELLY_KOKORO_URL to http://127.0.0.1:<port>.");
  }
  const token = process.env.KELLY_KOKORO_TOKEN || "";
  if (token.length < 24) throw new Error("Configure KELLY_KOKORO_TOKEN (at least 24 characters) in Kelly's .env.");
  for (const key of ["KELLY_KOKORO_MODEL_PATH", "KELLY_KOKORO_VOICES_PATH"]) {
    const value = process.env[key];
    if (!value || !(await fs.stat(path.resolve(root, value)).catch(() => null))?.isFile()) throw new Error(`Configure ${key} with an existing local file. No models were downloaded.`);
  }
  const voicePort = Number(voiceUrl.port || 80);
  if (voicePort === config.port) throw new Error("Dashboard and voice worker need different ports.");
  await assertFree(config.port);
  await assertFree(voicePort);
  // dotenv.config() above already merged the repo .env into process.env (without overriding
  // anything already set), so process.env here is the "effective env" resolveTunnelMode reads
  // KELLY_CLOUDFLARE_TUNNEL from. KELLY_CLOUDFLARE_TUNNEL and KELLY_PUBLIC_HOST, if set, pass
  // through to the child process via the spread below with no extra work.
  const tunnelMode = resolveTunnelMode(args, process.env);
  const env = { ...process.env, KELLY_TUNNEL: tunnelMode, KELLY_HOST: "127.0.0.1", HENRY_HOST: "127.0.0.1" };
  const publicOrigin = resolvePublicOrigin(process.env);
  if (publicOrigin) env.KELLY_PUBLIC_ORIGIN = publicOrigin;
  const dashboard = `http://127.0.0.1:${config.port}`;
  console.log("Starting Kelly dashboard and local speech worker. Ctrl+C in this window stops both.");
  await supervise([
    { file: process.execPath, args: [launcher, "voice", "serve"] },
    { file: process.execPath, args: [launcher, "dashboard"] },
  ], async (alive) => {
    await Promise.all([
      waitReady(new URL("/health", voiceUrl), { token, alive }),
      waitReady(`${dashboard}/api/health`, { alive }),
    ]);
    if (!alive()) return;
    console.log(`Kelly is ready.\nDashboard: ${dashboard}\nVoice: ${dashboard}/voice\n${tunnelMode === "off" ? "Local only. " : ""}Press Ctrl+C to stop both services.`);
    if (tunnelMode !== "off") {
      // Best-effort: the dashboard's own process already started/announced the tunnel; this
      // only decides whether to keep the Mac awake, so a failed check here must never crash
      // the launcher or stop Kelly.
      try {
        const remote = await fetch(`${dashboard}/api/remote`, { signal: AbortSignal.timeout(5000) });
        const status = await remote.json();
        maybeKeepAwake(tunnelMode, Boolean(status?.active), process.pid);
      } catch { /* tunnel status not readable yet; leave the Mac's sleep setting alone */ }
    }
  }, { env });
}
