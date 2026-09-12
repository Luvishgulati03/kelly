import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { ApprovalStore } from "../src/approval/store.ts";
import { XBrowserPostService, X_COMPOSER_SELECTOR, X_POST_BUTTON_SELECTOR, stagedTweetText, type XFrontEnd } from "../src/social/x-browser.ts";

test("X browser targets the hydrated composer and current/fallback post button ids", () => {
  assert.equal(X_COMPOSER_SELECTOR, '[data-testid="tweetTextarea_0"]');
  assert.match(X_POST_BUTTON_SELECTOR, /tweetButtonInline/);
  assert.match(X_POST_BUTTON_SELECTOR, /tweetButton/);
  assert.match(X_POST_BUTTON_SELECTOR, /:visible/);
});

test("stagedTweetText extracts only the body", () => {
  assert.equal(stagedTweetText("# Staged tweet\n\n## Tweet\n\nhello X\n"), "hello X");
  assert.throws(() => stagedTweetText("# missing"));
});

test("stageText creates an exact-text approval without changing the draft file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "henry-x-direct-"));
  const config = loadConfig(root);
  const activity = new ActivityLog(config.activityPath); await activity.init();
  const approvals = new ApprovalStore(config.approvalsPath); await approvals.init();
  const service = new XBrowserPostService(config, activity, approvals, { login: async () => undefined, post: async () => ({ url: "" }) });
  const result = await service.stageText("  bengaluru weather>  ");
  assert.equal(result.text, "bengaluru weather>");
  const item = await approvals.get(result.approvalId);
  assert.equal(item?.body, "bengaluru weather>");
  assert.equal(item?.status, "pending");
});

test("X browser flow stages before it can post and uses the approved exact text", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "henry-x-browser-"));
  const config = loadConfig(root);
  await fs.mkdir(path.join(config.socialDir, "staged"), { recursive: true });
  await fs.writeFile(path.join(config.socialDir, "staged", "2026-09-05.md"), "# Staged\n\n## Tweet\n\nship it, cautiously\n");
  const activity = new ActivityLog(config.activityPath); await activity.init();
  const approvals = new ApprovalStore(config.approvalsPath); await approvals.init();
  const sent: string[] = [];
  const browser: XFrontEnd = { login: async () => undefined, post: async (text) => { sent.push(text); return { url: "https://x.com/i/status/1" }; } };
  const service = new XBrowserPostService(config, activity, approvals, browser);
  const staged = await service.stage("2026-09-05");
  assert.equal(sent.length, 0);
  await approvals.setStatus(staged.approvalId, "approved");
  const item = await approvals.claimForExecution(staged.approvalId);
  assert.match(await service.submitApproved(item), /Posted to X/);
  assert.deepEqual(sent, ["ship it, cautiously"]);
});

test("approval stores refresh drafts created by another process", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "henry-approval-refresh-"));
  const filePath = path.join(root, "approvals.json");
  const dashboard = new ApprovalStore(filePath);
  const cli = new ApprovalStore(filePath);
  await dashboard.init();
  const created = await cli.create({ kind: "social.x-post", title: "Post to X", body: "hello", payload: { text: "hello" } });
  assert.equal((await dashboard.list())[0]?.id, created.id);
});
