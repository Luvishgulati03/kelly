import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HenryConfig } from "../config.ts";
import type { WorkflowDefinition } from "../types.ts";
import { safeEnvironment } from "../util/env.ts";

// ---------------------------------------------------------------------------
// File generation (unchanged behaviour: these only ever write into data/ and
// never touch the user's real crontab or launchd — that happens below).
// ---------------------------------------------------------------------------

function buildCronLines(config: HenryConfig, definitions: WorkflowDefinition[]): string[] {
  const enabled = definitions.filter((definition) => definition.enabled);
  return enabled.map((definition) => `${definition.cron} cd ${shellQuote(config.rootDir)} && npm run --silent schedule -- run ${shellQuote(definition.id)} >> ${shellQuote(path.join(config.dataDir, "scheduler.log"))} 2>&1`);
}

export async function writeCronFile(config: HenryConfig, definitions: WorkflowDefinition[]): Promise<string> {
  const lines = buildCronLines(config, definitions);
  const filePath = path.join(config.dataDir, "henry.cron");
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

/** Stable across runs — install/uninstall/status all key off this, so it must never depend on
 *  how many workflows happen to be enabled (an earlier version suffixed the count, which meant
 *  every enable/disable minted a NEW label and orphaned the previously-loaded agent). */
export const LAUNCHD_LABEL = "com.henry.scheduler";

function buildLaunchdPlistXml(config: HenryConfig): string {
  // launchd starts one long-lived scheduler process. Croner inside Henry owns
  // the individual expressions, so workflow IDs never enter a shell command.
  const args = ["/usr/bin/env", "npm", "run", "--silent", "schedule", "--", "daemon"];
  const argumentsXml = args.map((arg) => `<string>${xmlQuote(arg)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xmlQuote(LAUNCHD_LABEL)}</string><key>ProgramArguments</key><array>${argumentsXml}</array><key>WorkingDirectory</key><string>${xmlQuote(config.rootDir)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xmlQuote(path.join(config.dataDir, "scheduler.log"))}</string><key>StandardErrorPath</key><string>${xmlQuote(path.join(config.dataDir, "scheduler.log"))}</string></dict></plist>\n`;
}

export async function writeLaunchdPlist(config: HenryConfig, definitions: WorkflowDefinition[]): Promise<string> {
  void definitions; // kept in the signature for compatibility; the plist itself no longer varies by count
  const filePath = path.join(config.dataDir, "henry.launchd.plist");
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(filePath, buildLaunchdPlistXml(config), "utf8");
  return filePath;
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function xmlQuote(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

// ---------------------------------------------------------------------------
// Real installation: launchd (macOS user domain) + crontab (POSIX). Every
// shell-out is injected as `runCommand` so tests can fake it — nothing here
// ever touches the real crontab or launchd during `npm test`.
// ---------------------------------------------------------------------------

export interface CommandResult { stdout: string; stderr: string; exitCode: number | null; }
export type CommandRunner = (command: string, args: string[], input?: string) => Promise<CommandResult>;

/** Real subprocess runner — only reachable from production code paths, never from tests
 *  (tests always inject `runCommand` via `InstallDeps`). */
export const defaultCommandRunner: CommandRunner = (command, args, input) => {
  const child = spawn(command, args, { env: safeEnvironment(), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ stdout, stderr: `${stderr}${error.message}`, exitCode: null }));
    child.once("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
};

export interface InstallDeps {
  /** Injected for tests — defaults to a real subprocess spawn. */
  runCommand?: CommandRunner;
  homeDir?: string;
  platform?: NodeJS.Platform;
  /** Injected for tests — defaults to `process.getuid()` (undefined on non-POSIX platforms). */
  uid?: number;
}

interface ResolvedDeps { run: CommandRunner; homeDir: string; platform: NodeJS.Platform; uid: number | undefined; }

function resolveDeps(deps: InstallDeps): ResolvedDeps {
  return {
    run: deps.runCommand ?? defaultCommandRunner,
    homeDir: deps.homeDir ?? os.homedir(),
    platform: deps.platform ?? process.platform,
    uid: deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined),
  };
}

export type InstallResult =
  | { status: "installed"; label?: string; plistPath?: string; lines?: number }
  | { status: "removed"; label?: string; plistPath?: string }
  | { status: "not-installed"; label?: string; plistPath?: string }
  | { status: "unsupported"; message: string }
  | { status: "error"; message: string; label?: string; plistPath?: string };

function launchdAgentPath(homeDir: string): string {
  return path.join(homeDir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

/** Only old launchctl versions that do not know the modern verb qualify for the legacy fallback.
 * Permission, plist, path, and domain failures must be surfaced instead of being retried through
 * the deprecated loader, which can obscure the real error and change its semantics. */
function isUnsupportedBootstrapDiagnostic(result: CommandResult): boolean {
  const diagnostic = `${result.stderr}\n${result.stdout}`;
  return /\b(?:unknown|unrecognized|unsupported|invalid)\s+(?:subcommand|command)\b/i.test(diagnostic)
    || /\bbootstrap\b.*\b(?:not supported|not available)\b/i.test(diagnostic);
}

/**
 * Loads Henry's scheduler into the user's (not system) launchd: `launchctl bootstrap
 * gui/<uid> <plist>`, from a copy at the standard `~/Library/LaunchAgents/` path — never
 * bootstrapped straight out of `data/`. A `bootout` first makes this idempotent: running
 * install twice reloads the same agent instead of erroring on "already bootstrapped".
 * `launchctl load -w` is a fallback only for launchd predating the bootstrap/bootout verbs.
 */
export async function installLaunchd(config: HenryConfig, definitions: WorkflowDefinition[], deps: InstallDeps = {}): Promise<InstallResult> {
  const { run, homeDir, platform, uid } = resolveDeps(deps);
  if (platform !== "darwin") {
    return { status: "unsupported", message: "launchd is macOS-only. On this platform, use `henry schedule install --cron` instead." };
  }
  if (uid === undefined) {
    return { status: "error", message: "Could not determine the current user id — cannot target a user-level (gui/<uid>) launchd domain." };
  }
  const sourcePath = await writeLaunchdPlist(config, definitions); // refresh the reviewable copy in data/
  const content = await fs.readFile(sourcePath, "utf8");
  const agentPath = launchdAgentPath(homeDir);
  await fs.mkdir(path.dirname(agentPath), { recursive: true });
  await fs.writeFile(agentPath, content, "utf8");

  const domain = `gui/${uid}`;
  await run("launchctl", ["bootout", domain, agentPath]); // ignore failure — fine if it wasn't loaded
  const bootstrapResult = await run("launchctl", ["bootstrap", domain, agentPath]);
  if (bootstrapResult.exitCode !== 0) {
    if (!isUnsupportedBootstrapDiagnostic(bootstrapResult)) {
      return {
        status: "error",
        message: `launchctl bootstrap failed: ${bootstrapResult.stderr || bootstrapResult.stdout || "unknown error"}`,
        label: LAUNCHD_LABEL,
        plistPath: agentPath,
      };
    }
    const loadResult = await run("launchctl", ["load", "-w", agentPath]);
    if (loadResult.exitCode !== 0) {
      return {
        status: "error",
        message: `launchctl load -w failed: ${loadResult.stderr || loadResult.stdout || "unknown error"}`,
        label: LAUNCHD_LABEL,
        plistPath: agentPath,
      };
    }
  }
  return { status: "installed", label: LAUNCHD_LABEL, plistPath: agentPath };
}

/** Bootout + remove the LaunchAgent file. Safe to call when nothing is installed. */
export async function uninstallLaunchd(config: HenryConfig, deps: InstallDeps = {}): Promise<InstallResult> {
  void config;
  const { run, homeDir, platform, uid } = resolveDeps(deps);
  if (platform !== "darwin") return { status: "unsupported", message: "launchd is macOS-only; nothing to uninstall on this platform." };
  const agentPath = launchdAgentPath(homeDir);
  const installed = await fs.access(agentPath).then(() => true, () => false);
  // Always attempt bootout, even when the file has already disappeared. A manually
  // deleted plist can otherwise leave a loaded agent running forever.
  if (uid !== undefined) {
    const domain = `gui/${uid}`;
    // A path is convenient while the plist exists; the label is required when the
    // file was manually deleted but the service is still loaded.
    const target = installed ? agentPath : `${domain}/${LAUNCHD_LABEL}`;
    await run("launchctl", ["bootout", domain, target]); // best-effort
  }
  if (!installed) return { status: "not-installed", label: LAUNCHD_LABEL, plistPath: agentPath };
  await fs.rm(agentPath, { force: true });
  return { status: "removed", label: LAUNCHD_LABEL, plistPath: agentPath };
}

export interface LaunchdStatusReport {
  platform: "darwin" | "other";
  installed: boolean;
  loaded: boolean;
  label: string;
  plistPath: string;
}

export async function launchdStatus(config: HenryConfig, deps: InstallDeps = {}): Promise<LaunchdStatusReport> {
  void config;
  const { run, homeDir, platform } = resolveDeps(deps);
  const agentPath = launchdAgentPath(homeDir);
  if (platform !== "darwin") return { platform: "other", installed: false, loaded: false, label: LAUNCHD_LABEL, plistPath: agentPath };
  const installed = await fs.access(agentPath).then(() => true, () => false);
  const listResult = await run("launchctl", ["list", LAUNCHD_LABEL]);
  return { platform: "darwin", installed, loaded: listResult.exitCode === 0, label: LAUNCHD_LABEL, plistPath: agentPath };
}

// ---------------------------------------------------------------------------
// crontab: merge-only. The Henry block lives between two exact marker lines;
// everything else in the user's crontab is preserved byte-for-byte.
// ---------------------------------------------------------------------------

export const CRON_MARK_BEGIN = "# BEGIN henry";
export const CRON_MARK_END = "# END henry";

function splitLines(content: string): string[] {
  if (!content.length) return [];
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop(); // trailing newline artifact
  return lines;
}

/**
 * Pure and directly unit-testable. Replaces an existing `# BEGIN henry` … `# END henry` block
 * in place (so running install twice is a no-op diff, not a growing duplicate), or appends one
 * if Henry has never been installed. Every other line is passed through unchanged.
 */
export function mergeCrontab(existingCrontab: string, henryLines: string[]): string {
  const block = [CRON_MARK_BEGIN, ...henryLines, CRON_MARK_END];
  const lines = splitLines(existingCrontab);
  const beginIndex = lines.indexOf(CRON_MARK_BEGIN);
  const endIndex = lines.indexOf(CRON_MARK_END);
  const result = beginIndex !== -1 && endIndex !== -1 && endIndex > beginIndex
    ? [...lines.slice(0, beginIndex), ...block, ...lines.slice(endIndex + 1)]
    : lines.length ? [...lines, "", ...block] : block;
  return `${result.join("\n")}\n`;
}

/** Removes only the Henry-owned block (and the blank separator line install added before it).
 *  Everything else in the crontab is left exactly as it was. */
export function stripCrontabBlock(existingCrontab: string): string {
  const lines = splitLines(existingCrontab);
  const beginIndex = lines.indexOf(CRON_MARK_BEGIN);
  const endIndex = lines.indexOf(CRON_MARK_END);
  if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) return lines.length ? `${lines.join("\n")}\n` : "";
  const before = lines.slice(0, beginIndex);
  const after = lines.slice(endIndex + 1);
  if (before.length && before[before.length - 1] === "") before.pop();
  const result = [...before, ...after];
  return result.length ? `${result.join("\n")}\n` : "";
}

/** `crontab -l` semantics: exit 0 = existing content; the standard "no crontab" diagnostic
 *  means an empty crontab. Other nonzero exits are real errors and must not be mistaken for an
 *  empty crontab, or an install could overwrite a user's scheduler after a permission failure. */
async function readCrontab(run: CommandRunner): Promise<{ available: boolean; content: string; message?: string }> {
  const result = await run("crontab", ["-l"]);
  if (result.exitCode === null) return { available: false, content: "" };
  if (result.exitCode === 0) return { available: true, content: result.stdout };
  const diagnostic = `${result.stderr}\n${result.stdout}`;
  if (/no crontab for (?:user|\S+)/i.test(diagnostic)) return { available: true, content: "" };
  return { available: false, content: "", message: diagnostic.trim() || `crontab -l exited with code ${result.exitCode}` };
}

/** Merges Henry's block into the real crontab via `crontab -` (stdin), never truncating or
 *  regenerating the rest of it. Running this twice produces an identical crontab both times. */
export async function installCron(config: HenryConfig, definitions: WorkflowDefinition[], deps: InstallDeps = {}): Promise<InstallResult> {
  const { run } = resolveDeps(deps);
  await writeCronFile(config, definitions); // keep the reviewable data/henry.cron copy fresh too
  const henryLines = buildCronLines(config, definitions);
  const { available, content, message } = await readCrontab(run);
  if (!available) return { status: "unsupported", message: message ? `Could not read the user crontab: ${message}` : "The `crontab` command is not available on this system." };
  const merged = mergeCrontab(content, henryLines);
  const write = await run("crontab", ["-"], merged);
  if (write.exitCode !== 0) return { status: "error", message: `crontab install failed: ${write.stderr || write.stdout || "unknown error"}` };
  return { status: "installed", lines: henryLines.length };
}

/** Strips only Henry's block. If that was the entire crontab, removes the crontab outright
 *  (`crontab -r`) rather than leaving an empty file some crontab implementations reject. */
export async function uninstallCron(config: HenryConfig, deps: InstallDeps = {}): Promise<InstallResult> {
  void config;
  const { run } = resolveDeps(deps);
  const { available, content, message } = await readCrontab(run);
  if (!available) return { status: "unsupported", message: message ? `Could not read the user crontab: ${message}` : "The `crontab` command is not available on this system." };
  if (!content.includes(CRON_MARK_BEGIN)) return { status: "not-installed" };
  const stripped = stripCrontabBlock(content);
  if (stripped.trim() === "") {
    const remove = await run("crontab", ["-r"]);
    if (remove.exitCode !== 0) return { status: "error", message: `crontab removal failed: ${remove.stderr || remove.stdout || "unknown error"}` };
  } else {
    const write = await run("crontab", ["-"], stripped);
    if (write.exitCode !== 0) return { status: "error", message: `crontab update failed: ${write.stderr || write.stdout || "unknown error"}` };
  }
  return { status: "removed" };
}

export interface CronStatusReport { available: boolean; installed: boolean; }

export async function cronStatus(config: HenryConfig, deps: InstallDeps = {}): Promise<CronStatusReport> {
  void config;
  const { run } = resolveDeps(deps);
  const { available, content } = await readCrontab(run);
  if (!available) return { available: false, installed: false };
  return { available: true, installed: content.includes(CRON_MARK_BEGIN) };
}

// ---------------------------------------------------------------------------
// Combined status: launchd + cron + when the scheduler last actually ran.
// ---------------------------------------------------------------------------

export interface SchedulerLogReport { path: string; exists: boolean; lastModified?: string; lastLine?: string; }

async function schedulerLogStatus(config: HenryConfig): Promise<SchedulerLogReport> {
  const logPath = path.join(config.dataDir, "scheduler.log");
  try {
    const stat = await fs.stat(logPath);
    const content = await fs.readFile(logPath, "utf8").catch(() => "");
    const lines = content.split("\n").filter((line) => line.length > 0);
    return { path: logPath, exists: true, lastModified: stat.mtime.toISOString(), lastLine: lines[lines.length - 1] };
  } catch {
    return { path: logPath, exists: false };
  }
}

export interface SchedulerStatusReport { launchd: LaunchdStatusReport; cron: CronStatusReport; log: SchedulerLogReport; }

export async function schedulerStatus(config: HenryConfig, deps: InstallDeps = {}): Promise<SchedulerStatusReport> {
  return { launchd: await launchdStatus(config, deps), cron: await cronStatus(config, deps), log: await schedulerLogStatus(config) };
}
