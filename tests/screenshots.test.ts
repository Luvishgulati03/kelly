import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { ScreenshotSorterService } from "../src/screenshots/service.ts";
import type { ProviderRunner, RunOptions } from "../src/providers/runner.ts";
import type { RunResult } from "../src/types.ts";

function fakeRunner(reply: string, calls: Array<{ prompt: string; options: RunOptions }> = []): ProviderRunner {
  return {
    run: async (prompt: string, options: RunOptions = {}): Promise<RunResult> => {
      calls.push({ prompt, options });
      return { runId: "run-1", provider: "claude", response: reply, exitCode: 0, durationMs: 1, events: [] };
    },
  } as unknown as ProviderRunner;
}

async function setup(): Promise<{
  config: ReturnType<typeof loadConfig>;
  activity: ActivityLog;
  watchDir: string;
  sortedDir: string;
}> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-screenshots-"));
  const config = loadConfig(rootDir);
  const watchDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-screenshots-watch-"));
  const sortedDir = path.join(rootDir, "sorted-screenshots");
  config.screenshotsWatchDir = watchDir;
  config.screenshotsSortedDir = sortedDir;
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  return { config, activity, watchDir, sortedDir };
}

test("sortOne() classifies via the runner, moves the file, and records activity", async () => {
  const { config, activity, watchDir, sortedDir } = await setup();
  const calls: Array<{ prompt: string; options: RunOptions }> = [];
  const service = new ScreenshotSorterService(config, activity, fakeRunner("receipts", calls));

  const source = path.join(watchDir, "Screenshot 2026-08-06 at 10.00.00 AM.png");
  await fs.writeFile(source, "fake-png-bytes");

  const result = await service.sortOne(source);

  assert.equal(result.category, "receipts");
  assert.equal(result.destPath, path.join(sortedDir, "receipts", "Screenshot 2026-08-06 at 10.00.00 AM.png"));
  await fs.access(result.destPath);
  await assert.rejects(() => fs.access(source));

  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /Look at the image at/);
  assert.match(calls[0].prompt, new RegExp(path.resolve(source).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(calls[0].prompt, /receipts/);
  assert.deepEqual(calls[0].options, { readOnly: true, provider: "claude" });

  const events = await activity.list(10);
  const recorded = events.find((event) => event.metadata?.destPath === result.destPath);
  assert.ok(recorded, "expected an activity event for the sorted screenshot");
  assert.equal(recorded?.kind, "task.completed");
  assert.equal(recorded?.metadata?.screenshot, true);
  assert.equal(recorded?.metadata?.category, "receipts");
});

test("sortOne() is collision-safe: same filename sorted twice gets a -1 suffix", async () => {
  const { config, activity, watchDir, sortedDir } = await setup();
  const service = new ScreenshotSorterService(config, activity, fakeRunner("memes"));

  const name = "Screenshot 2026-08-06 at 11.00.00 AM.png";
  const first = path.join(watchDir, name);
  await fs.writeFile(first, "first");
  const firstResult = await service.sortOne(first);
  assert.equal(firstResult.destPath, path.join(sortedDir, "memes", name));

  const second = path.join(watchDir, name);
  await fs.writeFile(second, "second");
  const secondResult = await service.sortOne(second);
  assert.equal(secondResult.destPath, path.join(sortedDir, "memes", "Screenshot 2026-08-06 at 11.00.00 AM-1.png"));

  await fs.access(firstResult.destPath);
  await fs.access(secondResult.destPath);
  assert.equal(await fs.readFile(firstResult.destPath, "utf8"), "first");
  assert.equal(await fs.readFile(secondResult.destPath, "utf8"), "second");
});

test("sortOne() falls back to _unsorted when the model's reply isn't in the taxonomy", async () => {
  const { config, activity, watchDir, sortedDir } = await setup();
  const service = new ScreenshotSorterService(config, activity, fakeRunner("some-made-up-category"));

  const source = path.join(watchDir, "Screenshot 2026-08-06 at 12.00.00 PM.png");
  await fs.writeFile(source, "fake-png-bytes");

  const result = await service.sortOne(source);

  assert.equal(result.category, "_unsorted");
  assert.equal(result.destPath, path.join(sortedDir, "_unsorted", "Screenshot 2026-08-06 at 12.00.00 PM.png"));
  await fs.access(result.destPath);
});

test("classify() falls back to _unsorted when the provider run fails", async () => {
  const { config, activity } = await setup();
  const failingRunner = {
    run: async (): Promise<RunResult> => ({
      runId: "run-1", provider: "claude", response: "", exitCode: 1, durationMs: 1, error: "boom", events: [],
    }),
  } as unknown as ProviderRunner;
  const service = new ScreenshotSorterService(config, activity, failingRunner);

  const category = await service.classify("/tmp/does-not-matter.png");
  assert.equal(category, "_unsorted");
});

test("sortBacklog() sorts existing matching screenshots in the watch dir up to the limit", async () => {
  const { config, activity, watchDir, sortedDir } = await setup();
  const service = new ScreenshotSorterService(config, activity, fakeRunner("work"));

  await fs.writeFile(path.join(watchDir, "Screenshot 2026-08-01 at 09.00.00 AM.png"), "a");
  await fs.writeFile(path.join(watchDir, "Screenshot 2026-08-02 at 09.00.00 AM.png"), "b");
  await fs.writeFile(path.join(watchDir, "not-a-screenshot.png"), "c");
  await fs.writeFile(path.join(watchDir, "Screenshot 2026-08-03 at 09.00.00 AM.jpg"), "d");

  const results = await service.sortBacklog(1);

  assert.equal(results.length, 1);
  assert.equal(results[0].category, "work");
  await fs.access(path.join(sortedDir, "work", path.basename(results[0].destPath)));
  // The non-matching files are left untouched.
  await fs.access(path.join(watchDir, "not-a-screenshot.png"));
  await fs.access(path.join(watchDir, "Screenshot 2026-08-03 at 09.00.00 AM.jpg"));
});

test("watch() constructs a watcher and the returned close function tears it down cleanly", async () => {
  const { config, activity, watchDir } = await setup();
  void watchDir;
  const service = new ScreenshotSorterService(config, activity, fakeRunner("work"));

  const close = service.watch();
  assert.equal(typeof close, "function");
  assert.doesNotThrow(() => close());
});
