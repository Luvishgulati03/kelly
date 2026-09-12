import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeCronFile, writeLaunchdPlist } from "../src/scheduler/install.ts";
import { WorkflowScheduler } from "../src/scheduler/scheduler.ts";
import { ActivityLog } from "../src/activity.ts";
import { loadConfig, type HenryConfig } from "../src/config.ts";
import type { HenryMemory } from "../src/memory/engram.ts";
import type { GmailService } from "../src/integrations/gmail.ts";
import type { WorkflowDefinition } from "../src/types.ts";
import { recordTrackerEvent } from "../src/mailwatch/tracker.ts";

/** Runs `body` with the portfolio/GitHub variables (both env spellings) cleared, then restores them. */
async function withoutPortfolioEnv<T>(body: () => Promise<T>): Promise<T> {
  const keys = ["PORTFOLIO_DIR", "PORTFOLIO_SITE", "GITHUB_LOGIN"].flatMap((name) => [`HENRY_${name}`, `LAVU_${name}`]);
  const saved = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
  try { return await body(); }
  finally { for (const [key, value] of saved) if (value !== undefined) process.env[key] = value; }
}

test("scheduler installation writes reviewable cron and launchd artifacts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "henry-scheduler-"));
  const config = { rootDir: root, dataDir: path.join(root, "data") } as HenryConfig;
  const workflows: WorkflowDefinition[] = [
    { id: "dream", name: "Dream", cron: "0 2 * * *", kind: "memory.dream", enabled: true },
    { id: "disabled", name: "Disabled", cron: "*/5 * * * *", kind: "gmail.inbox", enabled: false },
  ];
  const cron = await writeCronFile(config, workflows);
  const plist = await writeLaunchdPlist(config, workflows);
  assert.match(await fs.readFile(cron, "utf8"), /dream/);
  // Stable label (not suffixed by enabled-workflow count) — install/uninstall/status all key
  // off this, and a count-suffixed label would orphan the previously-loaded agent on change.
  assert.match(await fs.readFile(plist, "utf8"), /com\.henry\.scheduler</);
  assert.match(await fs.readFile(plist, "utf8"), /schedule/);
});

/**
 * The FRAMEWORK ships with no portfolio repo and no GitHub account baked in: both are
 * configuration (HENRY_PORTFOLIO_DIR / HENRY_PORTFOLIO_SITE / HENRY_GITHUB_LOGIN), and an
 * unconfigured install must resolve them to "not set" rather than to the author's machine.
 */
test("portfolio and GitHub identity are configuration, with no baked-in defaults", async () => {
  await withoutPortfolioEnv(async () => {
    const bare = loadConfig(await fs.mkdtemp(path.join(os.tmpdir(), "henry-portfolio-defaults-")));
    assert.equal(bare.portfolioDir, undefined, "no portfolio path is baked in");
    assert.equal(bare.portfolioSite, undefined, "no portfolio URL is baked in");
    assert.equal(bare.githubLogin, undefined, "no GitHub account is baked in");

    process.env.HENRY_PORTFOLIO_DIR = "~/sites/mine";
    process.env.HENRY_PORTFOLIO_SITE = "https://example.github.io";
    process.env.HENRY_GITHUB_LOGIN = "octocat";
    const configured = loadConfig(await fs.mkdtemp(path.join(os.tmpdir(), "henry-portfolio-set-")));
    assert.equal(configured.portfolioDir, path.join(os.homedir(), "sites", "mine"), "~ expands, path is absolute");
    assert.equal(configured.portfolioSite, "https://example.github.io");
    assert.equal(configured.githubLogin, "octocat");
  });
});

/**
 * ...and the daily stats workflow must SKIP on either missing value instead of running `gh`
 * against somebody else's account. Both branches return before any filesystem or network work.
 */
test("portfolio stats workflow skips when the repo or the GitHub login is unconfigured", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "henry-portfolio-job-"));
  const config = {
    rootDir: root,
    dataDir: path.join(root, "data"),
    workflowsPath: path.join(root, "workflows.json"),
  } as HenryConfig;
  const activity = new ActivityLog(path.join(root, "data", "activity.jsonl"));
  await activity.init();
  const scheduler = new WorkflowScheduler(
    config, activity, undefined as unknown as HenryMemory, undefined as unknown as GmailService,
  );
  const definition: WorkflowDefinition = {
    id: "portfolio-stats-daily", name: "Portfolio stats", cron: "0 6 * * *", kind: "portfolio.stats", enabled: true,
  };

  const noRepo = await scheduler.run(definition) as { skipped?: boolean; reason?: string };
  assert.equal(noRepo.skipped, true);
  assert.match(noRepo.reason ?? "", /HENRY_PORTFOLIO_DIR/);

  // A configured repo but no account still skips — the contribution query needs a login.
  config.portfolioDir = path.join(root, "portfolio");
  const noLogin = await scheduler.run(definition) as { skipped?: boolean; reason?: string };
  assert.equal(noLogin.skipped, true);
  assert.match(noLogin.reason ?? "", /HENRY_GITHUB_LOGIN/);
});

/**
 * The private mirror was only ever as fresh as the last time somebody remembered to run the
 * script — a snapshot, not a backup. It is a scheduled workflow now, and these pin the two
 * properties that make an unattended backup safe to ship enabled: it SKIPS honestly when there
 * is nothing to back up to, and a failure can never take the scheduler daemon down.
 */
test("private backup workflow skips when no mirror is configured, and never throws on failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "henry-backup-job-"));
  const config = {
    rootDir: root,
    dataDir: path.join(root, "data"),
    workflowsPath: path.join(root, "workflows.json"),
  } as HenryConfig;
  const activity = new ActivityLog(path.join(root, "data", "activity.jsonl"));
  await activity.init();
  const scheduler = new WorkflowScheduler(
    config, activity, undefined as unknown as HenryMemory, undefined as unknown as GmailService,
  );
  const definition: WorkflowDefinition = {
    id: "private-mirror-backup", name: "Private mirror backup", cron: "30 22 * * *", kind: "backup.private", enabled: true,
  };

  // Point at a directory that is deliberately NOT a git mirror: a stranger who cloned Henry has
  // no ~/henry-private and must get one honest line, not a daily red failure.
  const previous = process.env.HENRY_PRIVATE_DIR;
  process.env.HENRY_PRIVATE_DIR = path.join(root, "not-a-mirror");
  try {
    const skipped = await scheduler.run(definition) as { skipped?: boolean; reason?: string };
    assert.equal(skipped.skipped, true);
    assert.match(skipped.reason ?? "", /no private mirror/i);

    // A real mirror directory, but no backup script — the failure path must still RESOLVE.
    await fs.mkdir(path.join(root, "not-a-mirror", ".git"), { recursive: true });
    const result = await scheduler.run(definition) as { skipped?: boolean; ok?: boolean };
    assert.ok(result.skipped === true || result.ok === false, "a missing script is reported, never thrown");
  } finally {
    if (previous === undefined) delete process.env.HENRY_PRIVATE_DIR;
    else process.env.HENRY_PRIVATE_DIR = previous;
  }
});

test("the shipped defaults schedule a daily private backup", async () => {
  const defaults = JSON.parse(await fs.readFile(path.join(process.cwd(), "workflows", "defaults.json"), "utf8")) as WorkflowDefinition[];
  const backup = defaults.find((entry) => entry.kind === "backup.private");
  assert.ok(backup, "a backup nobody scheduled is a snapshot");
  assert.equal(backup?.enabled, true);
});

test("job digest skips zero activity without notifying and sends only after a newly indexed record", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "henry-job-digest-"));
  const config = loadConfig(root);
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  const notifications: string[] = [];
  const scheduler = new WorkflowScheduler(
    config, activity, undefined as unknown as HenryMemory, undefined as unknown as GmailService,
    undefined, async (message) => { notifications.push(message); },
  );
  const definition: WorkflowDefinition = {
    id: "job-digest-night", name: "Job digest", cron: "30 21 * * *", kind: "mail.digest", enabled: true,
  };

  const empty = await scheduler.run(definition) as { skipped?: boolean; reason?: string };
  assert.equal(empty.skipped, true);
  assert.match(empty.reason ?? "", /no newly indexed job records/i);
  assert.deepEqual(notifications, []);

  await recordTrackerEvent(config, {
    company: "Acme", role: "Engineer", source: "generic", status: "applied",
    dateText: "2026-09-10T10:00:00.000Z", subject: "Henry browser confirmation: submitted",
  });
  const active = await scheduler.run(definition) as { skipped?: boolean };
  assert.notEqual(active.skipped, true);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0] ?? "", /newly indexed/);
  assert.match(notifications[0] ?? "", /indexed job records/);
});

test("the shipped defaults contain one daily job digest", async () => {
  const defaults = JSON.parse(await fs.readFile(path.join(process.cwd(), "workflows", "defaults.json"), "utf8")) as WorkflowDefinition[];
  const digests = defaults.filter((entry) => entry.kind === "mail.digest" && entry.enabled);
  assert.equal(digests.length, 1);
  assert.equal(digests[0]?.cron, "40 23 * * *", "digest runs after the mailwatch window");
});

test("scheduled digest reconciles submitted records before counting, with zero provider spend", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "henry-job-digest-reconcile-"));
  const config = loadConfig(root);
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  await fs.writeFile(config.jobApplicationsPath, JSON.stringify([{
    id: "submitted-draft", status: "submitted", submittedAt: "2026-09-09T10:00:00.000Z",
    posting: { company: "Acme", title: "Engineer", source: "generic" },
  }]));
  const notifications: string[] = [];
  const scheduler = new WorkflowScheduler(
    config, activity,
    { dream: async () => { throw new Error("provider-like memory work must not run"); } } as unknown as HenryMemory,
    { inbox: async () => { throw new Error("Gmail must not run"); } } as unknown as GmailService,
    undefined, async (message) => { notifications.push(message); },
  );
  const result = await scheduler.run({
    id: "job-digest-night", name: "Job digest", cron: "40 23 * * *", kind: "mail.digest", enabled: true,
  }) as { reconciliation?: { submittedRecords: number; created: number }; indexedJobRecords?: number };

  assert.equal(result.reconciliation?.submittedRecords, 1);
  assert.equal(result.reconciliation?.created, 1);
  assert.equal(result.indexedJobRecords, 1);
  assert.equal(notifications.length, 1);
});
