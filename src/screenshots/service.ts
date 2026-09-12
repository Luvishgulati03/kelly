import fsp from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import path from "node:path";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { ProviderRunner } from "../providers/runner.ts";

/** macOS default screenshot naming: "Screenshot 2026-08-06 at 10.32.11 AM.png". */
const SCREENSHOT_NAME_RE = /^Screenshot .*\.png$/i;
const DEBOUNCE_MS = 2000;
const UNSORTED = "_unsorted";

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

export interface SortResult {
  category: string;
  destPath: string;
}

export class ScreenshotSorterService {
  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    private readonly runner: ProviderRunner,
  ) {}

  private taxonomy(): string[] {
    return this.config.screenshotCategories.length ? this.config.screenshotCategories : [UNSORTED];
  }

  /** Matches the model's free-text reply against the configured taxonomy (case-insensitive). Anything else -> _unsorted. */
  private matchCategory(rawResponse: string): string {
    const byLower = new Map(this.taxonomy().map((category) => [category.toLowerCase(), category]));
    const cleaned = rawResponse.trim().toLowerCase().replace(/^[`"'*_.\s]+|[`"'*_.\s,;:]+$/g, "");
    if (byLower.has(cleaned)) return byLower.get(cleaned)!;
    const firstToken = cleaned.split(/\s+/)[0] || "";
    if (byLower.has(firstToken)) return byLower.get(firstToken)!;
    return UNSORTED;
  }

  /** Vision classification via the provider CLI: `claude -p` can read a local image path given in the prompt. */
  async classify(imagePath: string): Promise<string> {
    const categories = this.taxonomy();
    const absolute = path.resolve(imagePath);
    const prompt = [
      `Look at the image at ${absolute} and classify it into exactly one of: ${categories.join(", ")}.`,
      "Reply with ONLY the category slug.",
    ].join(" ");
    const result = await this.runner.run(prompt, { readOnly: true, provider: "claude" });
    if (result.exitCode !== 0 || !result.response.trim()) return UNSORTED;
    return this.matchCategory(result.response);
  }

  private async moveFile(sourcePath: string, destPath: string): Promise<void> {
    try {
      await fsp.rename(sourcePath, destPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EXDEV") {
        await fsp.copyFile(sourcePath, destPath);
        await fsp.unlink(sourcePath);
      } else {
        throw error;
      }
    }
  }

  private async moveWithCollisionSuffix(sourcePath: string, destDir: string): Promise<string> {
    const ext = path.extname(sourcePath);
    const stem = path.basename(sourcePath, ext);
    let destPath = path.join(destDir, `${stem}${ext}`);
    let suffix = 1;
    while (await pathExists(destPath)) {
      destPath = path.join(destDir, `${stem}-${suffix}${ext}`);
      suffix += 1;
    }
    await this.moveFile(sourcePath, destPath);
    return destPath;
  }

  /** Classify then deterministically move a single screenshot into sortedDir/<category>/, recording activity. */
  async sortOne(imagePath: string): Promise<SortResult> {
    const category = await this.classify(imagePath);
    const destDir = path.join(this.config.screenshotsSortedDir, category);
    await fsp.mkdir(destDir, { recursive: true, mode: 0o700 });
    const destPath = await this.moveWithCollisionSuffix(imagePath, destDir);
    await this.activity.record("task.completed", `Sorted screenshot into ${category}`, {
      screenshot: true, category, sourcePath: imagePath, destPath,
    });
    return { category, destPath };
  }

  /** Watches the configured screenshots directory; debounces per-file (screenshots write in stages) before sorting. */
  watch(): () => void {
    const dir = this.config.screenshotsWatchDir;
    const timers = new Map<string, NodeJS.Timeout>();

    const watcher = fsWatch(dir, (_eventType, filename) => {
      if (!filename) return;
      const name = filename.toString();
      if (!SCREENSHOT_NAME_RE.test(name)) return;
      const fullPath = path.join(dir, name);

      const existing = timers.get(fullPath);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        timers.delete(fullPath);
        void (async () => {
          if (!(await pathExists(fullPath))) return;
          await this.sortOne(fullPath).catch(() => undefined);
        })();
      }, DEBOUNCE_MS);
      timers.set(fullPath, timer);
    });

    return () => {
      watcher.close();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }

  /** Sorts existing screenshots already sitting in the watch dir (e.g. on startup, or on demand). */
  async sortBacklog(limit = 20): Promise<Array<{ imagePath: string } & SortResult>> {
    const dir = this.config.screenshotsWatchDir;
    const entries = await fsp.readdir(dir).catch(() => [] as string[]);
    const matches = entries.filter((name) => SCREENSHOT_NAME_RE.test(name)).slice(0, limit);

    const results: Array<{ imagePath: string } & SortResult> = [];
    for (const name of matches) {
      const imagePath = path.join(dir, name);
      const outcome = await this.sortOne(imagePath);
      results.push({ imagePath, ...outcome });
    }
    return results;
  }
}
