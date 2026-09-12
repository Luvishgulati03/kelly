import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Cron } from "croner";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { HenryMemory } from "../memory/engram.ts";
import type { GmailService } from "../integrations/gmail.ts";
import type { WorkflowDefinition } from "../types.ts";
import type { ReminderService, ReminderNotifier, PromptRunner, ExecuteApprovalFn } from "../reminders/service.ts";
import { notifyReminder } from "../reminders/service.ts";
import { startReminderTicker, type ReminderTickerHandle } from "../reminders/ticker.ts";
import { waitForInteractiveIdle } from "../orchestration/interactive-lock.ts";

/** Reads the pid recorded in a lock file; returns undefined if absent/unreadable. */
async function readLockPid(lockPath: string): Promise<number | undefined> {
  try {
    const pid = Number((await fs.readFile(lockPath, "utf8")).trim());
    return Number.isFinite(pid) ? pid : undefined;
  } catch { return undefined; }
}

/** Signal 0 checks liveness without killing the process. EPERM means it EXISTS (another user's) — alive. */
function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export class WorkflowScheduler {
  private jobs: Array<{ definition: WorkflowDefinition; cron: Cron }> = [];
  private reminderTicker?: ReminderTickerHandle;

  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    private readonly memory: HenryMemory,
    private readonly gmail: GmailService | undefined,
    private readonly reminders?: ReminderService,
    private readonly notifyReminderFn: ReminderNotifier = notifyReminder,
    private readonly promptRunner?: PromptRunner,
    private readonly executeApproval?: ExecuteApprovalFn,
  ) {}

  async definitions(): Promise<WorkflowDefinition[]> {
    try { return JSON.parse(await fs.readFile(this.config.workflowsPath, "utf8")) as WorkflowDefinition[]; }
    catch { return []; }
  }

  /** Check if a workflow can run in the current profile (all required services available). */
  private isWorkflowAvailable(definition: WorkflowDefinition): boolean {
    // Workflows that require specific services
    const requiresGmail = ["gmail.inbox"];
    const requiresMailwatch = ["mail.watch", "mail.digest"];
    const requiresJobs = ["jobs.scout", "mail.digest"];
    const requiresStandup = ["standup.prompt", "standup.scan", "standup.summary"];
    const requiresSocial = ["social.tweet"];

    if (requiresGmail.includes(definition.kind) && !this.gmail) return false;
    if (requiresMailwatch.includes(definition.kind) && this.config.profileId === "kelly") return false;
    if (requiresJobs.includes(definition.kind) && this.config.profileId === "kelly") return false;
    if (requiresStandup.includes(definition.kind) && this.config.profileId === "kelly") return false;
    if (requiresSocial.includes(definition.kind) && this.config.profileId === "kelly") return false;

    return true;
  }

  async start(options: { reminders?: boolean } = {}): Promise<WorkflowDefinition[]> {
    let definitions = (await this.definitions()).filter((definition) => definition.enabled);
    // Filter out workflows that require services not available in this profile
    definitions = definitions.filter((definition) => this.isWorkflowAvailable(definition));
    for (const definition of definitions) {
      // The .catch is load-bearing: dispatch() rethrows after recording, and an
      // unhandled rejection here would take down the whole repl/daemon process
      // (audit 2026-08-09 H1 — one offline `git push` at 21:00 killed everything).
      const cron = new Cron(definition.cron, { protect: true }, () => void this.run(definition).catch(() => undefined));
      this.jobs.push({ definition, cron });
    }
    await this.activity.record("workflow.started", `Started ${definitions.length} scheduled workflows`, { workflows: definitions.map((item) => item.id) });
    // The repl arms crons but keeps its own terminal-delivery reminder ticker.
    if (options.reminders !== false) this.armReminders();
    return definitions;
  }

  /**
   * Arms the reminder poller via the shared ticker (also used by repl/dashboard so reminders
   * fire inside any long-lived Henry process without a second one being started).
   */
  private armReminders(): void {
    if (!this.reminders) return;
    this.reminderTicker = startReminderTicker(this.reminders, this.activity, {
      notify: this.notifyReminderFn,
      promptRunner: this.promptRunner,
      executeApproval: this.executeApproval,
    });
  }

  /**
   * Cross-process serialization for EVERY cron kind: repl and the schedule daemon may
   * both arm the same definitions (so one open terminal = fully alive Henry), and the
   * pid lock guarantees a firing runs in exactly one process — the other skips. The
   * per-kind inline locks (knowledge/mailwatch) remain as belt-and-suspenders.
   */
  async run(definition: WorkflowDefinition): Promise<unknown> {
    const workflowLock = path.join(this.config.dataDir, `wf-${definition.id}.lock`);
    await fs.mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    // Atomic acquire (audit 2026-08-09 H3): `wx` refuses to overwrite an existing
    // lock, closing the read→check→write window where repl + daemon both grabbed
    // the same firing. On EEXIST we take over only from a dead holder, once.
    const acquire = async (): Promise<boolean> => {
      try {
        await fs.writeFile(workflowLock, String(process.pid), { encoding: "utf8", mode: 0o600, flag: "wx" });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        return false;
      }
    };
    let acquired = await acquire();
    if (!acquired) {
      const heldBy = await readLockPid(workflowLock);
      if (heldBy !== undefined && heldBy !== process.pid && isPidAlive(heldBy)) {
        return { skipped: true, reason: `workflow ${definition.id} already running in pid ${heldBy}` };
      }
      await fs.rm(workflowLock, { force: true }).catch(() => undefined);
      acquired = await acquire();
      if (!acquired) return { skipped: true, reason: `workflow ${definition.id} lock contested — another process won the takeover` };
    }
    try {
      return await this.dispatch(definition);
    } finally {
      await fs.rm(workflowLock, { force: true }).catch(() => undefined);
    }
  }

  private async dispatch(definition: WorkflowDefinition): Promise<unknown> {
    await this.activity.record("workflow.started", `Running workflow ${definition.id}`, { kind: definition.kind });
    try {
      let result: unknown;
      if (definition.kind === "memory.dream") result = await this.memory.dream();
      else if (definition.kind === "gmail.inbox") result = this.gmail ? await this.gmail.inbox(20) : { skipped: true, reason: "Gmail not available in this profile" };
      else if (definition.kind === "knowledge.distill") result = await this.runKnowledgeDistill(definition);
      else if (definition.kind === "mail.watch") result = await this.runMailWatch();
      else if (definition.kind === "standup.prompt" || definition.kind === "standup.scan" || definition.kind === "standup.summary") result = await this.runStandup(definition.kind, definition.session ?? "morning");
      else if (definition.kind === "portfolio.stats") result = await this.runPortfolioStats();
      else if (definition.kind === "mail.digest") result = await this.runJobDigest();
      else if (definition.kind === "jobs.scout") result = await this.runJobScout();
      else if (definition.kind === "social.tweet") result = await this.runDailyTweet();
      else if (definition.kind === "backup.private") result = await this.runPrivateBackup();
      else result = { skipped: true, reason: "agent.prompt workflows require an orchestrator callback" };
      await this.activity.record("workflow.completed", `Workflow ${definition.id} completed`, { result });
      return result;
    } catch (error) {
      await this.activity.record("workflow.failed", `Workflow ${definition.id} failed`, { error: String(error) });
      throw error;
    }
  }

  /**
   * Distills the organization's learning-platform modules into strategy cards. The KnowledgeBase (and its
   * resident embedding model) is constructed fresh for this one run and closed
   * before returning — the scheduler daemon may run for days between nightly
   * firings, so nothing about knowledge distillation should stay resident in
   * memory the rest of the time. A pid lock file guards data/knowledge.db against
   * concurrent writers (e.g. an overlapping manual run).
   */
  private async runKnowledgeDistill(definition: WorkflowDefinition): Promise<unknown> {
    const lockPath = path.join(this.config.dataDir, "knowledge.lock");
    const heldPid = await readLockPid(lockPath);
    if (heldPid !== undefined && isPidAlive(heldPid)) {
      return { skipped: true, reason: "knowledge.distill already running", pid: heldPid };
    }
    await fs.mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(lockPath, String(process.pid), { encoding: "utf8", mode: 0o600 });
    try {
      const { KnowledgeBase } = await import("../knowledge/store.ts");
      const { KnowledgeIngestor } = await import("../knowledge/ingest.ts");
      const { ProviderRunner } = await import("../providers/runner.ts");
      const kb = new KnowledgeBase(this.config);
      try {
        const runner = new ProviderRunner(this.config, this.activity);
        const ingestor = new KnowledgeIngestor(this.config, this.activity, kb, runner);
        return await ingestor.ingestCards({ limit: definition.batchLimit ?? 15 });
      } finally {
        kb.close();
      }
    } finally {
      await fs.rm(lockPath, { force: true });
    }
  }

  /**
   * Job-application inbox watch. Lazy-constructed per run, same shape as
   * `runKnowledgeDistill`. The alert-dedupe store makes overlapping runs harmless on its
   * own, but a pid lock (`data/mailwatch.lock`) still guards against two runs racing the
   * same `data/mailwatch.json` write.
   */
  private async runMailWatch(): Promise<unknown> {
    const lockPath = path.join(this.config.dataDir, "mailwatch.lock");
    const heldPid = await readLockPid(lockPath);
    if (heldPid !== undefined && isPidAlive(heldPid)) {
      return { skipped: true, reason: "mail.watch already running", pid: heldPid };
    }
    await fs.mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(lockPath, String(process.pid), { encoding: "utf8", mode: 0o600 });
    try {
      const { MailWatchService } = await import("../mailwatch/service.ts");
      const { ProviderRunner } = await import("../providers/runner.ts");
      await waitForInteractiveIdle(this.config); // yield to a live conversation first
      const runner = new ProviderRunner(this.config, this.activity);
      const service = new MailWatchService(this.config, this.activity, runner, this.notifyReminderFn, this.memory);
      // tick() applies the 5-random-checks-per-day plan; the cron firing every 30 min is just
      // the heartbeat that gives the plan a chance to notice a due time (see MailWatchService.tick).
      return await service.tick();
    } finally {
      await fs.rm(lockPath, { force: true });
    }
  }

  /**
   * Standup crons, lazy-constructed per run like `runMailWatch`. `scan` polls the group
   * FIRST (pull-before-scan), so collection works even when no long-lived Henry process
   * is holding the interval poller — the cron itself is a sufficient collector. All three
   * are safe no-ops while the Telegram group is unconfigured.
   */
  private async runStandup(kind: "standup.prompt" | "standup.scan" | "standup.summary", session: "morning" | "evening"): Promise<unknown> {
    if (!this.config.telegramBotToken || !this.config.telegramStandupChatId) {
      return { skipped: true, reason: "standup chat not configured" };
    }
    const { StandupStore } = await import("../standup/store.ts");
    const { StandupService } = await import("../standup/service.ts");
    const { StandupPoller } = await import("../standup/poller.ts");
    const { ProviderRunner } = await import("../providers/runner.ts");
    const store = new StandupStore(this.config);
    try {
      const runner = new ProviderRunner(this.config, this.activity);
      const service = new StandupService(this.config, this.activity, runner, store, this.notifyReminderFn, this.memory);
      if (kind === "standup.prompt") return await service.promptDay(undefined, session);
      const poller = new StandupPoller(this.config, this.activity, store);
      await poller.pollOnce();
      // Courtesy yield: if Luvish is mid-conversation in another process, let his turn
      // finish before spawning a provider CLI next to it (bounded — proceeds regardless).
      await waitForInteractiveIdle(this.config);
      if (kind === "standup.scan") return await service.scan();
      await service.scan(); // catch late posts before composing — the summary must not miss a last-minute update
      return await service.summarize(undefined, { session });
    } finally {
      store.close();
    }
  }

  /**
   * Daily portfolio stats refresh + deploy (Luvish's standing authorization,
   * 2026-08-09: "keeps on updating and pushing this on regular basis"). Refreshes
   * Henry's real numbers into the page and pushes — with two hard rails:
   * (1) a dirty working tree before the refresh means human/agent work is mid-flight
   * → skip; (2) local main already ahead of origin means UNSHIPPED page changes are
   * awaiting Luvish's go → skip, because this workflow must never be what first
   * publishes a redesign. Only when the sole diff is its own stats commit does it push.
   *
   * Nothing about the owner is baked in: both the repo (HENRY_PORTFOLIO_DIR) and the GitHub
   * account whose contribution graph is refreshed (HENRY_GITHUB_LOGIN) are configuration, and
   * an unset one skips the run with a reason rather than touching somebody else's repo/account.
   */
  /**
   * Refreshes the private full mirror (scripts/private-backup.sh). Without this the mirror is a
   * SNAPSHOT taken whenever someone remembers — the whole point of a backup is that nobody has to.
   *
   * Skips rather than fails when there is no mirror to push to: the public framework ships this
   * enabled, and a stranger who cloned Henry has no ~/henry-private and should see one honest
   * "not configured" line, not a daily red failure. The script itself is the authority on what is
   * excluded (secrets, the >100MB knowledge.db, the browser profile) — this only decides WHEN.
   */
  private async runPrivateBackup(): Promise<unknown> {
    const dest = process.env.HENRY_PRIVATE_DIR || path.join(os.homedir(), "henry-private");
    if (!(await fs.access(path.join(dest, ".git")).then(() => true, () => false))) {
      return { skipped: true, reason: `no private mirror at ${dest} — see PRIVATE-README.md in the mirror to initialize one` };
    }
    const script = path.join(this.config.rootDir, "scripts", "private-backup.sh");
    if (!(await fs.access(script).then(() => true, () => false))) {
      return { skipped: true, reason: "scripts/private-backup.sh is missing" };
    }
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    try {
      // Generous envelope: the sync is an rsync plus a git push over a ~150MB mirror, and a
      // backup that is killed halfway is worse than one that takes a minute.
      const { stdout } = await promisify(execFile)("bash", [script], { timeout: 10 * 60_000, cwd: this.config.rootDir });
      return { ok: true, output: stdout.trim().slice(-500) };
    } catch (error) {
      // Never throw: a failed backup must not take the whole scheduler daemon down with it.
      return { ok: false, error: error instanceof Error ? error.message.slice(0, 500) : String(error) };
    }
  }

  private async runPortfolioStats(): Promise<unknown> {
    const dir = this.config.portfolioDir;
    if (!dir) return { skipped: true, reason: "HENRY_PORTFOLIO_DIR is not set — no portfolio repo configured" };
    const login = this.config.githubLogin;
    if (!login) return { skipped: true, reason: "HENRY_GITHUB_LOGIN is not set — no GitHub account to read contribution stats for" };
    const script = path.join(dir, "scripts", "build-stats.mjs");
    if (!(await fs.access(script).then(() => true, () => false))) {
      return { skipped: true, reason: `portfolio scripts not found at ${dir}` };
    }
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const git = (...args: string[]) => run("git", ["-C", dir, ...args], { timeout: 60_000 });

    const dirtyBefore = (await git("status", "--porcelain")).stdout.trim();
    if (dirtyBefore) return { skipped: true, reason: "portfolio working tree has uncommitted work — not touching it" };
    // Fetch before the ahead-check (audit 2026-08-09 B-M24): a stale origin ref after
    // one failed push made this skip forever with a misleading reason.
    await git("fetch", "origin").catch(() => undefined);
    const ahead = Number((await git("rev-list", "--count", "origin/main..main")).stdout.trim());
    if (ahead > 0) return { skipped: true, reason: `local main is ${ahead} commit(s) ahead of origin — unshipped changes await Luvish's go` };

    // GitHub contribution graph: refetch real data (best-effort — offline keeps
    // yesterday's bake) and re-bake the static markup, so Luvish's commits appear
    // on the site within a day without the page ever making a runtime request.
    try {
      // JSON.stringify supplies the GraphQL string literal's quoting/escaping, so a login
      // carrying a quote cannot rewrite the query.
      const graph = await run("gh", ["api", "graphql", "-f",
        `query=query { user(login: ${JSON.stringify(login)}) { contributionsCollection { contributionCalendar { totalContributions weeks { contributionDays { contributionCount date } } } } } }`,
      ], { timeout: 60_000 });
      // Temp-then-promote (audit 2026-08-09 B-M24): writing the JSON before a bake
      // that then fails would commit data disagreeing with the HTML.
      const jsonPath = path.join(dir, "data", "github-contributions.json");
      const tmpJson = `${jsonPath}.tmp`;
      await fs.writeFile(tmpJson, graph.stdout, "utf8");
      await fs.rename(tmpJson, jsonPath);
      await run("node", [path.join(dir, "scripts", "build-heatmap.mjs")], { timeout: 60_000 });
    } catch {
      // Offline or gh unauthed: keep yesterday's bake. Restore consistency if the
      // JSON promoted but the bake failed — checkout discards the orphan data file.
      await git("checkout", "--", "data/github-contributions.json").catch(() => undefined);
    }

    await run("node", [script], { timeout: 120_000 });
    await run("node", [path.join(dir, "scripts", "refresh-stats.mjs")], { timeout: 30_000 });
    const changed = (await git("status", "--porcelain")).stdout.trim();
    if (!changed) return { skipped: true, reason: "stats unchanged" };

    await git("add", "-A");
    await git("commit", "-m", "chore: refresh Henry stats (automated daily)");
    await git("push", "origin", "main");
    await this.activity.record("workflow.completed", "Portfolio stats refreshed and deployed", { portfolio: true });
    return { deployed: true, changed: changed.split("\n").length };
  }

  /**
   * Morning job scout, lazy-constructed per run like `runMailWatch`. The service's own
   * once-per-day meta guard makes a re-fired cron a no-op; the pid lock only stops two
   * processes racing one browser profile. Not-logged-in and already-scouted both return
   * {skipped, reason} gracefully — `henry jobs login` is the one-time human fix. The
   * cron path never passes a prepare count: staging drafts is a Luvish-invoked CLI act.
   */
  private async runJobScout(): Promise<unknown> {
    const lockPath = path.join(this.config.dataDir, "scout.lock");
    const heldPid = await readLockPid(lockPath);
    if (heldPid !== undefined && isPidAlive(heldPid)) {
      return { skipped: true, reason: "jobs.scout already running", pid: heldPid };
    }
    await fs.mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(lockPath, String(process.pid), { encoding: "utf8", mode: 0o600 });
    try {
      const { JobScoutService } = await import("../jobs/scout.ts");
      const { ProviderRunner } = await import("../providers/runner.ts");
      const runner = new ProviderRunner(this.config, this.activity);
      const service = new JobScoutService(
        this.config, this.activity, runner, this.notifyReminderFn, this.memory,
        undefined, undefined,
        // Courtesy yield between browser collection and the scoring call — the browser
        // work contends for attention, not for the CPU a live provider turn needs.
        async () => { await waitForInteractiveIdle(this.config); },
      );
      return await service.scout();
    } finally {
      await fs.rm(lockPath, { force: true });
    }
  }

  /**
   * The daily tech tweet (soul.md's single standing outbound exception). The cron is only a
   * heartbeat across the afternoon window — TweetService picks one random minute inside it and
   * skips every earlier firing, so "whenever it gets a time" is a real jitter, not a fixed
   * 14:00 bot. Lazy-constructed per run like the other daily jobs. The kill switch
   * (`social.tweets.enabled`) makes this a pure no-op: no provider call, no network, nothing.
   */
  private async runDailyTweet(): Promise<unknown> {
    const { TweetService, tweetsEnabled } = await import("../social/tweets.ts");
    if (!tweetsEnabled(this.config.settingsPath)) return { skipped: true, reason: "social.tweets.enabled is off" };
    const { ProviderRunner } = await import("../providers/runner.ts");
    await waitForInteractiveIdle(this.config); // yield to a live conversation before spawning a provider
    const runner = new ProviderRunner(this.config, this.activity);
    const service = new TweetService(this.config, this.activity, runner, this.notifyReminderFn, this.memory);
    return await service.run({ trigger: "cron" });
  }

  /** Change-only job index to Telegram — counts from the tracker ledger, zero provider spend. */
  private async runJobDigest(): Promise<unknown> {
    const { reconcileSubmittedApplications, trackerDigest } = await import("../mailwatch/tracker.ts");
    const reconciliation = await reconcileSubmittedApplications(this.config);
    const digest = await trackerDigest(this.config);
    if (digest.newlyIndexed === 0 && digest.indexedUpdates === 0) {
      return { ...digest, reconciliation, skipped: true, reason: "no newly indexed job records or indexed status changes" };
    }
    await this.notifyReminderFn(digest.line, "Henry — job index");
    return { ...digest, reconciliation };
  }

  stop(): void {
    for (const job of this.jobs) job.cron.stop();
    this.jobs = [];
    this.reminderTicker?.stop();
    this.reminderTicker = undefined;
  }
}
