import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { JobApplicationDraft, JobApplicationSummary, ApplicationStatus } from "./types.ts";

export class JobApplicationStore {
  private items: JobApplicationDraft[] = [];
  private loaded = false;
  private mutationChain = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.filePath), 0o700).catch(() => undefined);
    await this.reload();
    await fs.chmod(this.filePath, 0o600).catch(() => undefined);
  }

  /** Fresh read of the on-disk array — the in-memory copy is only a cache. */
  private async reload(): Promise<void> {
    try { this.items = JSON.parse(await fs.readFile(this.filePath, "utf8")) as JobApplicationDraft[]; }
    catch { this.items = []; }
    this.loaded = true;
  }

  private async ensure(): Promise<void> { if (!this.loaded) await this.init(); }

  private async save(): Promise<void> {
    // tmp+rename so a concurrent reader (dashboard, another henry one-shot) never sees a torn file.
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    await fs.writeFile(tmp, `${JSON.stringify(this.items, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, this.filePath);
    await fs.chmod(this.filePath, 0o600).catch(() => undefined);
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationChain;
    let release!: () => void;
    this.mutationChain = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      // Re-read before applying (audit M11 — the reminders-clobber lesson): another
      // process may have written since this instance loaded its copy; mutating the
      // stale array and writing it back would silently erase those entries.
      if (this.loaded) await this.reload();
      else await this.init();
      return await operation();
    } finally { release(); }
  }

  async create(input: Omit<JobApplicationDraft, "id" | "createdAt" | "updatedAt">): Promise<JobApplicationDraft> {
    return this.mutate(async () => {
      const now = new Date().toISOString();
      const item: JobApplicationDraft = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
      this.items.push(item);
      await this.save();
      return item;
    });
  }

  async get(id: string): Promise<JobApplicationDraft | undefined> {
    await this.ensure();
    return this.items.find((item) => item.id === id);
  }

  async list(status?: ApplicationStatus): Promise<JobApplicationDraft[]> {
    await this.ensure();
    return this.items.filter((item) => !status || item.status === status).slice().reverse();
  }

  async update(id: string, patch: Partial<Omit<JobApplicationDraft, "id" | "createdAt">>): Promise<JobApplicationDraft> {
    return this.mutate(async () => {
      const item = this.items.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`Job application not found: ${id}`);
      Object.assign(item, patch, { updatedAt: new Date().toISOString() });
      await this.save();
      return item;
    });
  }

  /** Atomic compare-and-set for the durable pre-browser duplicate-submission fence. */
  async beginSubmission(id: string, expectedStatus: ApplicationStatus): Promise<JobApplicationDraft> {
    return this.mutate(async () => {
      const item = this.items.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`Job application not found: ${id}`);
      if (item.status !== expectedStatus) {
        throw new Error(`Application ${id} status changed from ${expectedStatus} to ${item.status}; refusing a possible duplicate`);
      }
      item.status = "submitting";
      item.updatedAt = new Date().toISOString();
      await this.save();
      return item;
    });
  }

  async summary(): Promise<JobApplicationSummary> {
    const items = await this.list();
    return {
      total: items.length,
      discovered: items.filter((item) => item.status === "discovered").length,
      drafted: items.filter((item) => item.status === "drafted").length,
      readyForReview: items.filter((item) => item.status === "ready-for-review").length,
      filled: items.filter((item) => item.status === "filled").length,
      submitting: items.filter((item) => item.status === "submitting").length,
      submitted: items.filter((item) => item.status === "submitted").length,
      rejected: items.filter((item) => item.status === "rejected").length,
      failed: items.filter((item) => item.status === "failed").length,
    };
  }
}
