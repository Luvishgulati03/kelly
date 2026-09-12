import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { LinkedInDraftService } from "../src/social/linkedin.ts";
import type { HenryMemory } from "../src/memory/engram.ts";
import type { ProviderRunner } from "../src/providers/runner.ts";
import type { RunResult } from "../src/types.ts";

const DRAFT_RESPONSE = "Shipped a notification platform nobody asked for the easy way. Here's what actually happened building it end to end.";

function fakeMemory(remembered: Array<{ content: string }> = []): HenryMemory {
  return {
    context: async () => "Luvish recently shipped the Henry notification platform.",
    remember: async (content: string) => { remembered.push({ content }); return "mem-id"; },
  } as unknown as HenryMemory;
}

function fakeRunner(capturedPrompts: string[], response = DRAFT_RESPONSE, exitCode = 0): ProviderRunner {
  return {
    run: async (prompt: string): Promise<RunResult> => {
      capturedPrompts.push(prompt);
      return { runId: "run-1", provider: "codex", response, exitCode, durationMs: 1, events: [] };
    },
  } as unknown as ProviderRunner;
}

async function setup(): Promise<{ config: ReturnType<typeof loadConfig>; activity: ActivityLog }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-linkedin-"));
  const config = loadConfig(rootDir);
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  await fs.writeFile(config.resumeSourcePath, "# Luvish's Resume\n\nShipped the notification platform.\n", "utf8");
  await fs.writeFile(path.join(rootDir, "personality.md"), "# Voice\n\nDirect, builder-minded, results-first.\n", "utf8");
  return { config, activity };
}

test("draft() writes a markdown file with the model's response", async () => {
  const { config, activity } = await setup();
  const remembered: Array<{ content: string }> = [];
  const prompts: string[] = [];
  const service = new LinkedInDraftService(config, activity, fakeMemory(remembered), fakeRunner(prompts));

  const result = await service.draft("Shipping the Henry notification platform");

  assert.match(result.markdownPath, /data\/social\/linkedin-\d{4}-\d{2}-\d{2}-shipping-the-henry-notification-platform\.md$/);
  await fs.access(result.markdownPath);
  const written = await fs.readFile(result.markdownPath, "utf8");
  assert.match(written, /Shipped a notification platform/);
  assert.equal(result.draft, DRAFT_RESPONSE);
});

test("draft() prompt includes personality.md voice and resume.md highlights", async () => {
  const { config, activity } = await setup();
  const prompts: string[] = [];
  const service = new LinkedInDraftService(config, activity, fakeMemory(), fakeRunner(prompts));

  await service.draft("Shipping the Henry notification platform");

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Direct, builder-minded, results-first\./);
  assert.match(prompts[0], /Shipped the notification platform\./);
  assert.match(prompts[0], /120-220 words/);
  assert.match(prompts[0], /No hashtag spam/);
});

test("draft() records activity and remembers the topic", async () => {
  const { config, activity } = await setup();
  const remembered: Array<{ content: string }> = [];
  const service = new LinkedInDraftService(config, activity, fakeMemory(remembered), fakeRunner([]));

  await service.draft("Shipping the Henry notification platform");

  assert.equal(remembered.length, 1);
  assert.match(remembered[0].content, /Shipping the Henry notification platform/);
  const events = await activity.list(10);
  assert.ok(events.some((event) => event.kind === "social.drafted"));
});

test("draft() throws when the model call fails", async () => {
  const { config, activity } = await setup();
  const service = new LinkedInDraftService(config, activity, fakeMemory(), fakeRunner([], "", 1));
  await assert.rejects(() => service.draft("Some topic"), /LinkedIn draft generation failed/);
});

test("draft() rejects an empty topic", async () => {
  const { config, activity } = await setup();
  const service = new LinkedInDraftService(config, activity, fakeMemory(), fakeRunner([]));
  await assert.rejects(() => service.draft("   "), /Usage: henry linkedin/);
});
