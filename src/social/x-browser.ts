import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { ApprovalItem } from "../types.ts";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { ApprovalStore } from "../approval/store.ts";
import { clearStaleProfileLocks } from "../jobs/scout.ts";

export interface XFrontEnd {
  login(): Promise<void>;
  post(text: string): Promise<{ url: string }>;
}

/** X has used both button test ids over time; prefer the current inline compose id. */
export const X_COMPOSER_SELECTOR = '[data-testid="tweetTextarea_0"]';
export const X_POST_BUTTON_SELECTOR = [
  '[data-testid="tweetButtonInline"]:visible',
  '[data-testid="tweetButton"]:visible',
].join(',');

function profileLockError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/profile|singleton|already running|target page|browser has been closed/i.test(message)) {
    return new Error("X browser profile is already open. Close Henry's X login/browser window, then approve the post again; the saved session will be reused.");
  }
  return error instanceof Error ? error : new Error(message);
}

/** Extract only the draft body; metadata never reaches the compose box. */
export function stagedTweetText(markdown: string): string {
  const match = markdown.match(/^## Tweet\s*\n+([\s\S]*?)\s*$/m);
  if (!match?.[1]) throw new Error("Staged tweet has no tweet body");
  const text = match[1].trim();
  if (!text || text.length > 280) throw new Error("Staged tweet is empty or exceeds 280 characters");
  return text;
}

export class PlaywrightXFrontEnd implements XFrontEnd {
  constructor(private readonly config: HenryConfig) {}

  private async context(): Promise<BrowserContext> {
    await fs.mkdir(this.config.browserProfileDir, { recursive: true, mode: 0o700 });
    await clearStaleProfileLocks(this.config.browserProfileDir);
    return chromium.launchPersistentContext(this.config.browserProfileDir, { headless: false, viewport: { width: 1440, height: 1000 } });
  }

  async login(): Promise<void> {
    const context = await this.context();
    const page = context.pages()[0] || await context.newPage();
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 45_000 });
    // Deliberately leave the headed session open for the operator to sign in; it is closed on Ctrl-C.
    await new Promise<void>((resolve) => process.once("SIGINT", resolve));
    await context.close();
  }

  async post(text: string): Promise<{ url: string }> {
    let context: BrowserContext;
    try { context = await this.context(); }
    catch (error) { throw profileLockError(error); }
    try {
      const page = context.pages()[0] || await context.newPage();
      await page.goto("https://x.com/compose/post", { waitUntil: "domcontentloaded", timeout: 45_000 });
      // X is an SPA: domcontentloaded happens before the composer is hydrated.
      // X keeps an inline composer and a modal composer mounted on this route. The
      // modal is the compose target opened by /compose/post; scope every irreversible
      // control to it so the underlying timeline cannot create a second match.
      const dialog = page.locator('[role="dialog"]').first();
      const root = await dialog.count() ? dialog : page;
      // X currently mounts duplicate visible composer nodes during hydration.
      // The first scoped composer is the one paired with the first scoped Post
      // button; strict count==1 incorrectly rejected a healthy logged-in page.
      const composer = root.locator(`${X_COMPOSER_SELECTOR}:visible`).first();
      await composer.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
      if (!(await composer.isVisible().catch(() => false))) {
        throw new Error("X composer unavailable — sign in with `henry tweet browser login` and close that window before posting");
      }
      await composer.fill(text);
      // One exact, known irreversible target. Never fall back to labels or generic buttons.
      const button = root.locator(X_POST_BUTTON_SELECTOR).first();
      await button.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
      if (!(await button.isVisible().catch(() => false))) {
        throw new Error("Could not identify exactly one visible X Post button; no post was made");
      }
      if (await button.isDisabled()) throw new Error("X Post button is disabled; no post was made");
      await button.click();
      // A successful post clears the composer and normally redirects. Either is a
      // positive signal; a fixed sleep alone caused false failures on slow X sessions.
      await page.waitForTimeout(1_000);
      const sent = await page.locator('[data-testid="toast"]').filter({ hasText: /sent|posted|published/i }).count().catch(() => 0);
      const leftCompose = !page.url().includes("/compose/");
      const composerCleared = !(await composer.isVisible().catch(() => false));
      if (!sent && !leftCompose && !composerCleared) {
        throw new Error("X did not confirm the post; its status is unknown — check X before retrying");
      }
      const statusLink = await page.locator('a[href*="/status/"]').first().getAttribute("href").catch(() => null);
      const url = statusLink ? new URL(statusLink, "https://x.com").toString() : page.url();
      return { url };
    } finally { await context.close().catch(() => undefined); }
  }
}

export class XBrowserPostService {
  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    private readonly approvals: ApprovalStore,
    private readonly browser: XFrontEnd = new PlaywrightXFrontEnd(config),
  ) {}

  private stagedPath(date = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })): string {
    return path.join(this.config.socialDir, "staged", `${date}.md`);
  }

  async stage(date?: string): Promise<{ approvalId: string; text: string; stagedPath: string }> {
    const stagedPath = this.stagedPath(date);
    const text = stagedTweetText(await fs.readFile(stagedPath, "utf8"));
    const result = await this.stageText(text, stagedPath);
    return { ...result, stagedPath };
  }

  /** Stage an explicitly supplied tweet without mutating the daily draft file. */
  async stageText(text: string, stagedPath?: string): Promise<{ approvalId: string; text: string; stagedPath?: string }> {
    const normalized = text.trim();
    if (!normalized || normalized.length > 280) throw new Error("Tweet is empty or exceeds 280 characters");
    const approval = await this.approvals.create({
      kind: "social.x-post", title: "Post approved tweet to X", body: normalized,
      payload: { text: normalized, ...(stagedPath ? { stagedPath } : {}) },
    });
    await this.activity.record("social.drafted", `X browser post awaiting approval: ${normalized.slice(0, 120)}`, { approvalId: approval.id, ...(stagedPath ? { stagedPath } : {}) });
    return { approvalId: approval.id, text: normalized, ...(stagedPath ? { stagedPath } : {}) };
  }

  async submitApproved(item: ApprovalItem): Promise<string> {
    if (item.kind !== "social.x-post") throw new Error(`Not an X post approval: ${item.id}`);
    const text = typeof item.payload.text === "string" ? item.payload.text : "";
    if (!text || text !== item.body || text.length > 280) throw new Error("X post approval has invalid text; no post was made");
    const result = await this.browser.post(text);
    await this.activity.record("social.posted", `Posted to X via browser: ${text.slice(0, 120)}`, { approvalId: item.id, url: result.url });
    return `Posted to X: ${result.url}`;
  }

  async login(): Promise<void> { await this.browser.login(); }
}
