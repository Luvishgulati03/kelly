import dotenv from "dotenv";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getActiveProfile } from "./profile.ts";
import { parseTradeId, tradePack, type TradeId } from "./trade/index.ts";

// Profile-aware env loading: Henry and Kelly share one repo .env (disambiguated by
// HENRY_*/KELLY_* prefixes — see `env()` below) but keep separate state directories.
// Both profiles root-anchor to the repo .env so every command finds it regardless of
// the caller's cwd, not just `kelly start`; an already-exported var or a cwd .env still
// wins, because dotenv never overrides a variable that is already set.
function loadProfileEnv(): void {
  // Test isolation (tests/isolate.mjs): the owner's repo/cwd .env must never reach a test
  // process. dotenv only fills variables that are unset, so a test that deletes e.g.
  // KELLY_TUNNEL before the first loadConfig() would otherwise get the owner's value back.
  if (process.env.HENRY_TEST_ISOLATION === "1") return;
  dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
  dotenv.config();
}

// Load on first config call (lazy), not at module import time
let envLoaded = false;

/** The neutral fallback for `ownerName` when no `<PREFIX>OWNER_NAME` is configured. */
export const DEFAULT_OWNER_NAME = "the owner";

const DEFAULT_SCREENSHOT_CATEGORIES = ["work", "design-reference", "receipts", "memes", "documents", "code", "_unsorted"];
// No titles are baked in: an unconfigured scout skips with a reason (src/jobs/scout.ts) until
// HENRY_JOB_SCOUT_TITLES is set or `jobs alerts-sync` learns them from the owner's job-alert mail.
const DEFAULT_JOB_SCOUT_TITLES: string[] = [];

export interface HenryConfig {
  profileId: "henry" | "kelly";
  /** Commerce is always active for Kelly and opt-in for Henry. */
  commerceEnabled: boolean;
  rootDir: string;
  dataDir: string;
  memoryDir: string;
  capturedMemoryDir: string;
  dbPath: string;
  activityPath: string;
  approvalsPath: string;
  settingsPath: string;
  workflowsPath: string;
  /** Directory holding markdown workflows (`*.workflow.md`) for the workflow engine. */
  workflowsDir: string;
  host: string;
  port: number;
  dashboardToken?: string;
  allowRemoteDashboard: boolean;
  provider: "codex" | "claude";
  /** Chief/orchestrator model for normal Codex work (t1). */
  codexModel?: string;
  /** Fast delegated-worker model for t0 work. */
  codexT0Model?: string;
  /** Deep specialist model for t2 work. */
  codexT2Model?: string;
  /** Codex-only job role override for resume tailoring. */
  codexResumeTailorModel?: string;
  /** Codex-only job role override for application review. */
  codexApplicationReviewModel?: string;
  /** Codex-only job role override for application management. */
  codexApplicationManagerModel?: string;
  /** Chief/orchestrator model for normal Claude work (t1). Blank = the CLI's own default. */
  claudeModel?: string;
  /** Fast delegated-worker model for t0 work on Claude. */
  claudeT0Model?: string;
  /** Deep specialist model for t2 work on Claude. */
  claudeT2Model?: string;
  requireOutboundApproval: boolean;
  /** The owner's own email address (HENRY_OWNER_EMAIL; legacy DAD_EMAIL still honoured). */
  ownerEmail?: string;
  /**
   * The owner's own name, used in runtime prompts, messages, and UI text
   * (HENRY_OWNER_NAME / KELLY_OWNER_NAME). Defaults to the neutral "the owner"
   * so an unconfigured install never invents or inherits someone else's name.
   */
  ownerName: string;
  knowledgeDir: string;
  knowledgeDbPath: string;
  /** Recall-event JSONL sink for src/metrics/recall-metrics.ts (docs/dashboard-design-v2.md §C). */
  metricsDir: string;
  /** Seed eval queries live here; `henry knowledge eval` writes its report to last-run.json in the same directory. */
  evalPath: string;
  jobApplicationsPath: string;
  jobProfilePath: string;
  resumeSourcePath: string;
  resumeOutputDir: string;
  browserProfileDir: string;
  browserHeadless: boolean;
  screenshotCategories: string[];
  screenshotsWatchDir: string;
  screenshotsSortedDir: string;
  whisperModelPath?: string;
  meetingsDir: string;
  goalsDir: string;
  remindersPath: string;
  socialDir: string;
  /** Operator-notification channel only (never a general send-to-anyone surface). */
  telegramBotToken?: string;
  telegramChatId?: string;
  /** Explicit opt-in for local code edits and research initiated from the owner's Telegram DM. */
  telegramOperatorMode: boolean;
  /** The team standup group — the ONLY chat the standup poller reads and the group sender writes. */
  telegramStandupChatId?: string;
  /**
   * The owner's portfolio repo checkout (HENRY_PORTFOLIO_DIR) — the portfolio.stats workflow
   * refreshes + deploys it. No path is baked in: unset means the capability is off (the agent
   * prompt drops the portfolio instructions and the workflow skips with a reason).
   */
  portfolioDir?: string;
  /** Public URL that portfolio repo publishes to (HENRY_PORTFOLIO_SITE) — display only, never fetched. */
  portfolioSite?: string;
  /**
   * GitHub account whose contribution graph the portfolio stats refresh reads (HENRY_GITHUB_LOGIN).
   * Unset means the workflow skips rather than querying somebody else's account.
   */
  githubLogin?: string;
  /** PM MODE: Henry operates as a project manager (PMBOK-grounded decisions with rationale). Persisted in settings.json. */
  pmMode: boolean;
  standupDbPath: string;
  /** Rendered per-day standup summaries the owner actually reads (`data/standups/<date>.md`). */
  standupsDir: string;
  mailwatchPath: string;
  /** Today's randomized check-times plan (§ mailwatch tick planner) — separate file so a corrupt/racy write never touches the dedupe state in `mailwatchPath`. */
  mailwatchPlanPath: string;
  /** Canonical job-application ledger (keyed company+role, status history) — the source of truth `job-tracker.md` is regenerated from. */
  jobTrackerPath: string;
  /** Human-readable ledger the owner actually reads — regenerated from `jobTrackerPath` after every update. */
  jobTrackerMarkdownPath: string;
  draftRepliesDir: string;
  /** Morning job-scout role titles (HENRY_JOB_SCOUT_TITLES, comma-separated; empty until configured). */
  jobScoutTitles: string[];
  /** Job-scout search location (HENRY_JOB_SCOUT_LOCATION, default "Remote"). */
  jobScoutLocation: string;
  /** Scout dedupe + once-per-day meta (data/scout.db, WAL) — same idioms as standupDbPath. */
  scoutDbPath: string;
  /** Learned job-alert profile (jobs alerts-sync) — overrides jobScoutTitles when present. */
  scoutProfilePath: string;
  /** Per-day ranked shortlists the owner actually reads (`data/scout/<date>.md`). */
  scoutDir: string;
  /** Fixed-per-install trade pack (KELLY_TRADE), chosen at setup; defaults to "electrical". */
  trade: TradeId;
  /** Shop name shown in the prompt and dashboard (KELLY_SHOP_NAME); defaults to the trade pack's default. */
  shopName: string;
}

const thisFile = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(thisFile), "..");

/** Reads from the active profile's env prefix (HENRY_ or KELLY_), then legacy LAVU_<name>. */
function env(name: string): string | undefined {
  const profile = getActiveProfile();
  return process.env[`${profile.envPrefix}${name}`] ?? process.env[`LAVU_${name}`];
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function resolveFromRoot(rootDir: string, value: string | undefined, fallback: string): string {
  const selected = value || fallback;
  return path.isAbsolute(selected) ? selected : path.resolve(rootDir, selected);
}

/** Expands a leading `~` (or `~/...`) to the current user's home directory. */
function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseScreenshotCategories(value: string | undefined): string[] {
  if (!value) return DEFAULT_SCREENSHOT_CATEGORIES;
  const parsed = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return parsed.length ? parsed : DEFAULT_SCREENSHOT_CATEGORIES;
}

function parseJobScoutTitles(value: string | undefined): string[] {
  if (!value) return DEFAULT_JOB_SCOUT_TITLES;
  const parsed = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return parsed.length ? parsed : DEFAULT_JOB_SCOUT_TITLES;
}

/**
 * A NAMED ROOT OUTRANKS THE AMBIENT ENVIRONMENT.
 *
 * `HENRY_DATA_DIR` / `HENRY_MEMORY_DIR` relocate the DEPLOYMENT — the tree you get when nobody
 * names one. A caller that passes `rootDir` has named one, and it must get that tree: a dozen
 * callers each naming their own directory were all landing on one shared path the moment an
 * absolute `HENRY_DATA_DIR` was exported into the process, which is not a relocation but a
 * collision (P5 audit — `tests/isolate.mjs` exports exactly such a variable so the modules
 * that resolve `HENRY_DATA_DIR || "data"` themselves and have no root to name stop writing
 * into a live deployment).
 *
 * The env variable is a FALLBACK for the unnamed case, not an override of an explicit argument.
 * `HenryRuntime.create()` — the one production path — names no root, so the deployment resolves
 * exactly as it always has.
 */
export function loadConfig(rootDir = defaultRoot): HenryConfig {
  // Load env vars on first call (profile-aware)
  if (!envLoaded) {
    loadProfileEnv();
    envLoaded = true;
  }

  const named = rootDir !== defaultRoot;
  const profile = getActiveProfile();

  // Kelly's state lives in ~/.kelly by default, separate from source root
  // Henry's state lives in its source root (backward compatible)
  const effectiveRoot = profile.id === "kelly" && rootDir === defaultRoot
    ? path.join(os.homedir(), ".kelly")
    : rootDir;

  const dataDir = resolveFromRoot(effectiveRoot, named ? undefined : env("DATA_DIR"), "data");
  const memoryDir = resolveFromRoot(effectiveRoot, named ? undefined : env("MEMORY_DIR"), "memory");
  // No portfolio path is baked in — an unset variable stays undefined so callers can tell
  // "not configured" from "configured to somewhere", rather than inheriting the author's tree.
  const portfolioDir = env("PORTFOLIO_DIR");
  const trade = parseTradeId(env("TRADE"));
  return {
    profileId: profile.id,
    commerceEnabled: profile.id === "kelly" || bool(env("COMMERCE_ENABLED"), false),
    rootDir,
    dataDir,
    memoryDir,
    capturedMemoryDir: path.join(memoryDir, "captured"),
    dbPath: path.join(dataDir, "engram.db"),
    activityPath: path.join(dataDir, "activity.jsonl"),
    approvalsPath: path.join(dataDir, "approvals.json"),
    settingsPath: path.join(dataDir, "settings.json"),
    workflowsPath: resolveFromRoot(rootDir, env("WORKFLOWS_PATH"), "workflows/defaults.json"),
    workflowsDir: resolveFromRoot(rootDir, env("WORKFLOWS_DIR"), "workflows"),
    host: env("HOST") || "127.0.0.1",
    port: Number(env("PORT") || 7337),
    dashboardToken: env("DASHBOARD_TOKEN") || undefined,
    allowRemoteDashboard: bool(env("ALLOW_REMOTE_DASHBOARD"), false),
    provider: profile.id === "kelly" ? "codex" : env("PROVIDER") === "claude" ? "claude" : "codex",
    // Keep the model policy inside Henry instead of inheriting an operator's global
    // Codex setting. The owner's orchestration contract: Sol coordinates ordinary
    // work, a cheaper 5.5 worker handles t0 tasks, and Luna gets the hard t2 work.
    codexModel: env("CODEX_MODEL") || "gpt-5.6-sol",
    codexT0Model: env("CODEX_T0_MODEL") || "gpt-5.5",
    codexT2Model: env("CODEX_T2_MODEL") || "gpt-5.6-luna",
    codexResumeTailorModel: env("CODEX_RESUME_TAILOR_MODEL") || "gpt-5.5",
    // GPT-5.4 is available in the API but rejected by Codex with this ChatGPT
    // account. Keep the role configurable; default to the cheapest verified
    // subscription model instead of silently failing every review.
    codexApplicationReviewModel: env("CODEX_APPLICATION_REVIEW_MODEL") || "gpt-5.5",
    codexApplicationManagerModel: env("CODEX_APPLICATION_MANAGER_MODEL") || "gpt-5.6-sol",
    // The same tiering on the Claude seat, so switching provider is a config change and
    // never a code change. Defaults reproduce the long-standing hardcoded behaviour
    // (t0 → haiku, t2 → opus); t1 stays blank so the CLI's own default wins.
    claudeModel: profile.id === "kelly" ? undefined : env("CLAUDE_MODEL") || undefined,
    claudeT0Model: profile.id === "kelly" ? undefined : env("CLAUDE_T0_MODEL") || "haiku",
    claudeT2Model: profile.id === "kelly" ? undefined : env("CLAUDE_T2_MODEL") || "opus",
    requireOutboundApproval: bool(env("REQUIRE_OUTBOUND_APPROVAL"), true),
    ownerEmail: env("OWNER_EMAIL") || process.env.DAD_EMAIL || undefined,
    ownerName: env("OWNER_NAME") || DEFAULT_OWNER_NAME,
    knowledgeDir: resolveFromRoot(rootDir, env("KNOWLEDGE_DIR"), "knowledge"),
    knowledgeDbPath: path.join(dataDir, "knowledge.db"),
    metricsDir: path.join(dataDir, "metrics"),
    evalPath: path.join(dataDir, "eval", "queries.json"),
    jobApplicationsPath: path.join(dataDir, "job-applications.json"),
    jobProfilePath: resolveFromRoot(rootDir, env("JOB_PROFILE_PATH"), "application-profile.md"),
    resumeSourcePath: resolveFromRoot(rootDir, env("RESUME_SOURCE_PATH"), "resume.md"),
    resumeOutputDir: path.join(dataDir, "resumes"),
    browserProfileDir: resolveFromRoot(rootDir, env("BROWSER_PROFILE_DIR"), "data/browser-profile"),
    browserHeadless: bool(env("BROWSER_HEADLESS"), false),
    screenshotCategories: parseScreenshotCategories(env("SCREENSHOT_CATEGORIES")),
    screenshotsWatchDir: path.resolve(expandHome(env("SCREENSHOTS_DIR") || "~/Desktop")),
    screenshotsSortedDir: path.resolve(expandHome(env("SCREENSHOTS_SORTED_DIR") || "~/Pictures/sorted-screenshots")),
    whisperModelPath: env("WHISPER_MODEL") || undefined,
    meetingsDir: path.join(dataDir, "meetings"),
    goalsDir: path.join(dataDir, "goals"),
    remindersPath: path.join(dataDir, "reminders.json"),
    socialDir: path.join(dataDir, "social"),
    telegramBotToken: env("TELEGRAM_BOT_TOKEN") || undefined,
    telegramChatId: env("TELEGRAM_CHAT_ID") || undefined,
    telegramOperatorMode: bool(env("TELEGRAM_OPERATOR_MODE"), false),
    telegramStandupChatId: env("TELEGRAM_STANDUP_CHAT_ID") || undefined,
    portfolioDir: portfolioDir ? path.resolve(expandHome(portfolioDir)) : undefined,
    portfolioSite: env("PORTFOLIO_SITE") || undefined,
    githubLogin: env("GITHUB_LOGIN") || undefined,
    pmMode: false,
    standupDbPath: path.join(dataDir, "standups.db"),
    standupsDir: path.join(dataDir, "standups"),
    mailwatchPath: path.join(dataDir, "mailwatch.json"),
    mailwatchPlanPath: path.join(dataDir, "mailwatch-plan.json"),
    jobTrackerPath: path.join(dataDir, "job-tracker.json"),
    jobTrackerMarkdownPath: path.join(dataDir, "job-tracker.md"),
    draftRepliesDir: path.join(dataDir, "drafts"),
    jobScoutTitles: parseJobScoutTitles(env("JOB_SCOUT_TITLES")),
    jobScoutLocation: env("JOB_SCOUT_LOCATION") || "Remote",
    scoutDbPath: path.join(dataDir, "scout.db"),
    scoutProfilePath: path.join(dataDir, "scout-profile.json"),
    scoutDir: path.join(dataDir, "scout"),
    trade,
    shopName: env("SHOP_NAME") || tradePack(trade).defaultShopName,
  };
}
