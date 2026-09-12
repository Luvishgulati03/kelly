import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ApprovalItem } from "../types.ts";

/** How long a mutation waits for another process's lock before giving up. */
const LOCK_WAIT_MS = 10_000;
/** A lock older than this is assumed to belong to a process that died holding it. */
const STALE_LOCK_MS = 60_000;

export class ApprovalStore {
  private items: ApprovalItem[] = [];
  private loaded = false;
  private lastLoadedMtimeMs = -1;
  private mutationChain = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.filePath), 0o700).catch(() => undefined);
    await this.reload();
    await fs.chmod(this.filePath, 0o600).catch(() => undefined);
    this.loaded = true;
  }

  private async ensure(): Promise<void> { if (!this.loaded) await this.init(); }

  /**
   * The REPL/CLI and the dashboard are separate Node processes but share one
   * approval file. Refresh reads so a long-running dashboard sees drafts made
   * by a CLI command instead of displaying a stale, empty queue.
   */
  private async reload(): Promise<void> {
    try {
      const stat = await fs.stat(this.filePath);
      this.items = JSON.parse(await fs.readFile(this.filePath, "utf8")) as ApprovalItem[];
      this.lastLoadedMtimeMs = stat.mtimeMs;
    } catch {
      this.items = [];
      this.lastLoadedMtimeMs = -1;
    }
  }

  private async refreshIfChanged(): Promise<void> {
    await this.ensure();
    try {
      if ((await fs.stat(this.filePath)).mtimeMs > this.lastLoadedMtimeMs) await this.reload();
    } catch {
      if (this.lastLoadedMtimeMs !== -1) await this.reload();
    }
  }

  private async save(): Promise<void> {
    await fs.writeFile(this.filePath, `${JSON.stringify(this.items, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(this.filePath, 0o600).catch(() => undefined);
    this.lastLoadedMtimeMs = (await fs.stat(this.filePath)).mtimeMs;
  }

  /**
   * Cross-process exclusion around the approval file.
   *
   * The in-process chain below only serialises callers inside ONE Node process, but the
   * REPL/CLI, the dashboard and the scheduler are separate processes sharing this file
   * (see `refreshIfChanged`). Without this, two of them could both read an item as
   * `approved`, both write `executing`, and both execute it — for a job application that
   * means submitting to a real employer twice. `wx` gives us the atomic create-or-fail
   * the file system already guarantees; the read-modify-write happens inside it.
   *
   * A lock whose owning process died is worse than no lock, so a lock older than
   * STALE_LOCK_MS is broken deliberately rather than blocking every future mutation.
   */
  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    let handle: import("node:fs/promises").FileHandle | undefined;
    for (;;) {
      try { handle = await fs.open(lockPath, "wx", 0o600); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const age = await fs.stat(lockPath).then((s) => Date.now() - s.mtimeMs).catch(() => 0);
        if (age > STALE_LOCK_MS) { await fs.rm(lockPath, { force: true }).catch(() => undefined); continue; }
        if (Date.now() > deadline) throw new Error(`Timed out waiting for the approval lock at ${lockPath}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      await handle.writeFile(`${process.pid}`).catch(() => undefined);
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await fs.rm(lockPath, { force: true }).catch(() => undefined);
    }
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationChain;
    let release!: () => void;
    this.mutationChain = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      // The refresh must happen INSIDE the file lock: reading before we hold it would
      // re-introduce exactly the stale-read race the lock exists to close.
      return await this.withFileLock(async () => {
        await this.refreshIfChanged();
        return await operation();
      });
    } finally { release(); }
  }

  async create(input: Omit<ApprovalItem, "id" | "createdAt" | "updatedAt" | "status">): Promise<ApprovalItem> {
    return this.mutate(async () => {
      await this.ensure();
      const now = new Date().toISOString();
      const item: ApprovalItem = { ...input, id: randomUUID(), createdAt: now, updatedAt: now, status: "pending" };
      this.items.push(item);
      await this.save();
      return item;
    });
  }

  async list(status?: ApprovalItem["status"]): Promise<ApprovalItem[]> {
    await this.refreshIfChanged();
    return this.items.filter((item) => !status || item.status === status).slice().reverse();
  }

  async get(id: string): Promise<ApprovalItem | undefined> {
    await this.refreshIfChanged();
    return this.items.find((item) => item.id === id);
  }

  async setStatus(id: string, status: ApprovalItem["status"], result?: string): Promise<ApprovalItem> {
    return this.mutate(async () => {
      await this.ensure();
      const item = this.items.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`Approval item not found: ${id}`);
      const allowed = item.status === "pending" ? ["approved", "rejected"] : item.status === "approved" ? ["executing", "rejected"] : item.status === "executing" ? ["executed", "failed"] : [];
      if (!allowed.includes(status)) throw new Error(`Invalid approval transition: ${item.status} -> ${status}`);
      item.status = status;
      item.updatedAt = new Date().toISOString();
      if (result !== undefined) item.result = result;
      await this.save();
      return item;
    });
  }

  /** Atomically claim an explicitly approved action for execution. */
  async claimForExecution(id: string): Promise<ApprovalItem> {
    return this.mutate(async () => {
      await this.ensure();
      const item = this.items.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`Approval item not found: ${id}`);
      if (item.status !== "approved") {
        throw new Error(
          `Approval ${id} is ${item.status}; Luvish's explicit approval is required before execution`,
        );
      }
      item.status = "executing";
      item.updatedAt = new Date().toISOString();
      await this.save();
      return item;
    });
  }
}
