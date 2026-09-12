/**
 * Small process-local cache for hot read paths.
 *
 * SQLite/Engram remains the source of truth. This cache is deliberately bounded
 * and TTL-based so a long-lived dashboard, REPL, or Telegram process cannot grow
 * without limit or serve a value forever. The interface is intentionally narrow:
 * an optional Redis adapter can implement the same get/set/delete contract later
 * without making Redis a requirement for local Henry deployments.
 */
export interface CacheBackend {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs: number): void;
  delete(key: string): void;
  clear(): void;
}

interface Entry {
  value: unknown;
  expiresAt: number;
  touchedAt: number;
}

export interface MemoryCacheOptions {
  maxEntries?: number;
  now?: () => number;
}

export class MemoryCache implements CacheBackend {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  private sequence = 0;

  constructor(options: MemoryCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 256);
    this.now = options.now ?? Date.now;
  }

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const now = this.now();
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    entry.touchedAt = ++this.sequence;
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    const now = this.now();
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      this.entries.delete(key);
      return;
    }
    this.entries.set(key, { value, expiresAt: now + ttlMs, touchedAt: ++this.sequence });
    while (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
      if (!oldest) break;
      this.entries.delete(oldest[0]);
    }
  }

  delete(key: string): void { this.entries.delete(key); }
  clear(): void { this.entries.clear(); }
  get size(): number { return this.entries.size; }
}

/** Cache-aside helper with request coalescing for concurrent identical reads. */
export class HotCache {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly backend: CacheBackend = new MemoryCache()) {}

  async getOrSet<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const cached = this.backend.get<T>(key);
    if (cached !== undefined) return cached;
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const request = load().then((value) => {
      this.backend.set(key, value, ttlMs);
      return value;
    }).finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, request);
    return request;
  }

  delete(key: string): void { this.backend.delete(key); }
  clear(): void { this.backend.clear(); this.inFlight.clear(); }
}

/** Shared only inside this Node process; no personal data leaves the machine. */
export const hotCache = new HotCache(new MemoryCache({ maxEntries: 256 }));
