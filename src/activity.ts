import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ActivityEvent, ActivityKind } from "./types.ts";

export class ActivityLog {
  private readonly recent: ActivityEvent[] = [];

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.filePath), 0o700).catch(() => undefined);
    try { await fs.access(this.filePath); } catch { await fs.writeFile(this.filePath, "", { encoding: "utf8", mode: 0o600 }); }
    await fs.chmod(this.filePath, 0o600).catch(() => undefined);
  }

  async record(
    kind: ActivityKind,
    message: string,
    metadata?: Record<string, unknown>,
    extra?: Pick<ActivityEvent, "runId" | "role" | "provider">,
  ): Promise<ActivityEvent> {
    const event: ActivityEvent = {
      id: randomUUID(), timestamp: new Date().toISOString(), kind, message,
      ...(metadata ? { metadata } : {}), ...extra,
    };
    this.recent.push(event);
    while (this.recent.length > 500) this.recent.shift();
    await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  async list(limit = 100): Promise<ActivityEvent[]> {
    const inMemory = this.recent.slice(-limit);
    if (inMemory.length >= Math.min(limit, 20)) return inMemory.reverse();
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return raw.split("\n").filter(Boolean).slice(-limit).reverse().map((line) => JSON.parse(line) as ActivityEvent);
    } catch { return inMemory.reverse(); }
  }
}
