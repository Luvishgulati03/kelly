import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  writeCronFile, writeLaunchdPlist, mergeCrontab, stripCrontabBlock,
  installCron, uninstallCron, cronStatus,
  installLaunchd, uninstallLaunchd, launchdStatus,
  type CommandRunner,
} from "../src/scheduler/install.ts";
import type { HenryConfig } from "../src/config.ts";
import type { WorkflowDefinition } from "../src/types.ts";

// Every test below injects `runCommand` (and, for launchd, `homeDir`/`platform`/`uid`) so
// NOTHING in this file ever spawns a real `crontab` or `launchctl` process — see the rail
// in context.md: tests must never touch the real crontab or launchd.

const WORKFLOWS: WorkflowDefinition[] = [
  { id: "dream", name: "Dream", cron: "0 2 * * *", kind: "memory.dream", enabled: true },
];

async function tmpConfig(prefix: string): Promise<HenryConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return { rootDir: root, dataDir: path.join(root, "data") } as HenryConfig;
}

/** In-memory fake standing in for the real user crontab: `-l` reads it, `-` (stdin) replaces
 *  it, `-r` deletes it. `undefined` means "no crontab for this user", matching real crontab's
 *  nonzero exit for `-l` in that case. */
function fakeCrontab(initial: string | undefined) {
  let stored = initial;
  const calls: Array<{ args: string[]; input?: string }> = [];
  const run: CommandRunner = async (command, args, input) => {
    assert.equal(command, "crontab");
    calls.push({ args, input });
    if (args[0] === "-l") {
      return stored === undefined
        ? { stdout: "", stderr: "no crontab for user\n", exitCode: 1 }
        : { stdout: stored, stderr: "", exitCode: 0 };
    }
    if (args[0] === "-") { stored = input ?? ""; return { stdout: "", stderr: "", exitCode: 0 }; }
    if (args[0] === "-r") { stored = undefined; return { stdout: "", stderr: "", exitCode: 0 }; }
    throw new Error(`unexpected crontab args: ${args.join(" ")}`);
  };
  return { run, calls, get stored() { return stored; } };
}

test("mergeCrontab preserves unrelated lines exactly and delimits Henry's block", () => {
  const existing = "MAILTO=me@example.com\n0 9 * * * /usr/bin/true\n";
  const merged = mergeCrontab(existing, ["*/5 * * * * echo hi"]);
  assert.equal(merged, "MAILTO=me@example.com\n0 9 * * * /usr/bin/true\n\n# BEGIN henry\n*/5 * * * * echo hi\n# END henry\n");
});

test("mergeCrontab replaces an existing Henry block in place instead of duplicating it", () => {
  const existing = "0 9 * * * /usr/bin/true\n\n# BEGIN henry\n0 1 * * * old-line\n# END henry\n";
  const merged = mergeCrontab(existing, ["0 2 * * * new-line"]);
  assert.equal(merged, "0 9 * * * /usr/bin/true\n\n# BEGIN henry\n0 2 * * * new-line\n# END henry\n");
  assert.equal((merged.match(/# BEGIN henry/g) ?? []).length, 1);
});

test("stripCrontabBlock removes only Henry's block, leaving unrelated lines byte-for-byte", () => {
  const existing = "MAILTO=me@example.com\n0 9 * * * /usr/bin/true\n\n# BEGIN henry\n0 2 * * * henry-line\n# END henry\n";
  assert.equal(stripCrontabBlock(existing), "MAILTO=me@example.com\n0 9 * * * /usr/bin/true\n");
});

test("henry schedule install --cron is idempotent: running it twice yields a byte-identical crontab with one block", async () => {
  const config = await tmpConfig("henry-cron-install-");
  const fake = fakeCrontab("0 9 * * * /usr/bin/true\n");

  const first = await installCron(config, WORKFLOWS, { runCommand: fake.run });
  assert.equal(first.status, "installed");
  const afterFirst = fake.stored;
  assert.ok(afterFirst?.includes("0 9 * * * /usr/bin/true"), "unrelated line survives");
  assert.equal((afterFirst?.match(/# BEGIN henry/g) ?? []).length, 1);

  const second = await installCron(config, WORKFLOWS, { runCommand: fake.run });
  assert.equal(second.status, "installed");
  assert.equal(fake.stored, afterFirst, "second install is a no-op diff");
  assert.equal((fake.stored?.match(/# BEGIN henry/g) ?? []).length, 1, "no duplicate block");
});

test("henry schedule uninstall --cron removes only Henry's block", async () => {
  const config = await tmpConfig("henry-cron-uninstall-");
  const fake = fakeCrontab("0 9 * * * /usr/bin/true\n");
  await installCron(config, WORKFLOWS, { runCommand: fake.run });
  assert.ok(fake.stored?.includes("BEGIN henry"));

  const result = await uninstallCron(config, { runCommand: fake.run });
  assert.equal(result.status, "removed");
  assert.equal(fake.stored, "0 9 * * * /usr/bin/true\n");
});

test("henry schedule uninstall --cron removes the crontab entirely when Henry's block was the only content", async () => {
  const config = await tmpConfig("henry-cron-uninstall-solo-");
  const fake = fakeCrontab(undefined);
  await installCron(config, WORKFLOWS, { runCommand: fake.run });
  assert.ok(fake.stored?.includes("BEGIN henry"));

  const result = await uninstallCron(config, { runCommand: fake.run });
  assert.equal(result.status, "removed");
  assert.equal(fake.stored, undefined, "crontab -r was used instead of writing an empty file");
});

test("henry schedule uninstall --cron is a clean no-op when Henry was never installed", async () => {
  const config = await tmpConfig("henry-cron-uninstall-noop-");
  const fake = fakeCrontab("0 9 * * * /usr/bin/true\n");
  const result = await uninstallCron(config, { runCommand: fake.run });
  assert.equal(result.status, "not-installed");
  assert.equal(fake.stored, "0 9 * * * /usr/bin/true\n", "untouched");
});

test("cron lifecycle does not overwrite the crontab after a read error", async () => {
  const config = await tmpConfig("henry-cron-read-error-");
  const run: CommandRunner = async (command, args) => {
    assert.equal(command, "crontab");
    assert.deepEqual(args, ["-l"]);
    return { stdout: "", stderr: "crontab: permission denied", exitCode: 1 };
  };
  const result = await installCron(config, WORKFLOWS, { runCommand: run });
  assert.equal(result.status, "unsupported");
  assert.match((result as { message: string }).message, /permission denied/);
});

test("cronStatus reports unavailable / not-installed / installed correctly", async () => {
  const config = await tmpConfig("henry-cron-status-");
  const missing: CommandRunner = async () => ({ stdout: "", stderr: "spawn crontab ENOENT", exitCode: null });
  assert.deepEqual(await cronStatus(config, { runCommand: missing }), { available: false, installed: false });

  const empty = fakeCrontab(undefined);
  assert.deepEqual(await cronStatus(config, { runCommand: empty.run }), { available: true, installed: false });

  const withHenry = fakeCrontab(undefined);
  await installCron(config, WORKFLOWS, { runCommand: withHenry.run });
  assert.deepEqual(await cronStatus(config, { runCommand: withHenry.run }), { available: true, installed: true });
});

test("henry schedule install --launchd gives a clear message on a non-macOS platform instead of throwing", async () => {
  const config = await tmpConfig("henry-launchd-nonmac-");
  const result = await installLaunchd(config, WORKFLOWS, { platform: "linux" });
  assert.equal(result.status, "unsupported");
  assert.match((result as { message: string }).message, /macOS/);
});

test("launchdStatus reports \"other\" cleanly on a non-macOS platform", async () => {
  const config = await tmpConfig("henry-launchd-status-nonmac-");
  const result = await launchdStatus(config, { platform: "linux" });
  assert.equal(result.platform, "other");
  assert.equal(result.installed, false);
  assert.equal(result.loaded, false);
});

test("launchd install/status/uninstall round-trip against a faked macOS launchctl, and install is idempotent", async () => {
  const config = await tmpConfig("henry-launchd-root-");
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-launchd-home-"));
  const agentPath = path.join(homeDir, "Library", "LaunchAgents", "com.henry.scheduler.plist");

  let loaded = false;
  const calls: Array<{ args: string[] }> = [];
  const run: CommandRunner = async (command, args) => {
    assert.equal(command, "launchctl");
    calls.push({ args });
    if (args[0] === "bootout") { loaded = false; return { stdout: "", stderr: "", exitCode: 0 }; }
    if (args[0] === "bootstrap") { loaded = true; return { stdout: "", stderr: "", exitCode: 0 }; }
    if (args[0] === "list") return loaded
      ? { stdout: "PID\t-\tcom.henry.scheduler\n", stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "Could not find service", exitCode: 1 };
    throw new Error(`unexpected launchctl args: ${args.join(" ")}`);
  };
  const deps = { runCommand: run, homeDir, platform: "darwin" as NodeJS.Platform, uid: 501 };

  const before = await launchdStatus(config, deps);
  assert.equal(before.installed, false);
  assert.equal(before.loaded, false);

  const installed = await installLaunchd(config, WORKFLOWS, deps);
  assert.equal(installed.status, "installed");
  const plistContent = await fs.readFile(agentPath, "utf8");
  assert.match(plistContent, /com\.henry\.scheduler/);
  assert.match(plistContent, /schedule/);

  const after = await launchdStatus(config, deps);
  assert.equal(after.installed, true);
  assert.equal(after.loaded, true);

  // Idempotency: installing again must bootout first, so a second bootstrap never errors
  // as "already bootstrapped" and the agent stays loaded exactly once.
  const second = await installLaunchd(config, WORKFLOWS, deps);
  assert.equal(second.status, "installed");
  const bootouts = calls.filter((c) => c.args[0] === "bootout").length;
  const bootstraps = calls.filter((c) => c.args[0] === "bootstrap").length;
  assert.equal(bootouts, 2);
  assert.equal(bootstraps, 2);

  const removed = await uninstallLaunchd(config, deps);
  assert.equal(removed.status, "removed");
  const existsAfter = await fs.access(agentPath).then(() => true, () => false);
  assert.equal(existsAfter, false, "the LaunchAgent file is deleted on uninstall");

  const afterUninstall = await uninstallLaunchd(config, deps);
  assert.equal(afterUninstall.status, "not-installed", "uninstall is a clean no-op the second time");
});

test("launchd uninstall boots out a stale service when the plist was already deleted", async () => {
  const config = await tmpConfig("henry-launchd-stale-");
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-launchd-stale-home-"));
  const calls: string[][] = [];
  const run: CommandRunner = async (command, args) => {
    assert.equal(command, "launchctl");
    calls.push(args);
    return { stdout: "", stderr: "service not found", exitCode: 1 };
  };
  const result = await uninstallLaunchd(config, { runCommand: run, homeDir, platform: "darwin", uid: 501 });
  assert.equal(result.status, "not-installed");
  assert.deepEqual(calls, [["bootout", "gui/501", "gui/501/com.henry.scheduler"]]);
});

test("launchd falls back to `launchctl load -w` when bootstrap is unavailable", async () => {
  const config = await tmpConfig("henry-launchd-fallback-");
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-launchd-fallback-home-"));
  const calls: string[] = [];
  const run: CommandRunner = async (command, args) => {
    calls.push(args[0]);
    if (args[0] === "bootstrap") return { stdout: "", stderr: "Unrecognized subcommand", exitCode: 64 };
    if (args[0] === "load") return { stdout: "", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 }; // bootout
  };
  const result = await installLaunchd(config, WORKFLOWS, { runCommand: run, homeDir, platform: "darwin", uid: 501 });
  assert.equal(result.status, "installed");
  assert.deepEqual(calls, ["bootout", "bootstrap", "load"]);
});

test("launchd does not fall back to deprecated load after a bootstrap permission failure", async () => {
  const config = await tmpConfig("henry-launchd-permission-");
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-launchd-permission-home-"));
  const calls: string[] = [];
  const run: CommandRunner = async (command, args) => {
    calls.push(args[0]);
    if (args[0] === "bootstrap") return { stdout: "", stderr: "Operation not permitted", exitCode: 1 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const result = await installLaunchd(config, WORKFLOWS, { runCommand: run, homeDir, platform: "darwin", uid: 501 });
  assert.equal(result.status, "error");
  assert.match((result as { message: string }).message, /bootstrap failed.*Operation not permitted/);
  assert.deepEqual(calls, ["bootout", "bootstrap"]);
});

test("shell metacharacters in the root path are quoted safely in the cron line and the plist XML", async () => {
  const config = await tmpConfig("henry-quote-");
  const tricky = "/tmp/a'b\"c&d<e>f";
  const quotedConfig = { rootDir: tricky, dataDir: config.dataDir } as HenryConfig;

  const cronPath = await writeCronFile(quotedConfig, WORKFLOWS);
  const cronContent = await fs.readFile(cronPath, "utf8");
  // A raw `'` in the value must be closed-out and re-opened ('\''), never break out of the
  // surrounding single-quoted shell literal.
  assert.ok(cronContent.includes(`cd '/tmp/a'\\''b"c&d<e>f' &&`), cronContent);

  const plistPath = await writeLaunchdPlist(quotedConfig, WORKFLOWS);
  const plistContent = await fs.readFile(plistPath, "utf8");
  assert.ok(plistContent.includes(`<string>/tmp/a'b&quot;c&amp;d&lt;e&gt;f</string>`), plistContent);
});
