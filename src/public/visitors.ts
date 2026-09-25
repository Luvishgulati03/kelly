import crypto from "node:crypto";

/**
 * Anonymous visitors, kept in memory only. A visitor is a random id in an HttpOnly cookie; the
 * server holds that visitor's capped conversation and the last few replies Kelly gave them (so
 * the talk page can ask for those exact replies to be spoken). Nothing here is an identity or an
 * authorization, nothing is ever written to disk, and an idle visitor is simply forgotten.
 * Dropping the cookie starts a new, empty conversation. Visitors never see each other.
 */

export const VISITOR_COOKIE = "kelly_visitor";
const VISITOR_ID = /^[A-Za-z0-9_-]{24}$/;

export function newVisitorId(): string {
  return crypto.randomBytes(18).toString("base64url");
}

export function isVisitorId(value: string | undefined): value is string {
  return typeof value === "string" && VISITOR_ID.test(value);
}

export function readVisitorCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== VISITOR_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    return isVisitorId(value) ? value : undefined;
  }
  return undefined;
}

/** HttpOnly always; Secure whenever the request came through the tunnel (https at the edge). */
export function visitorCookie(id: string, secure: boolean, maxAgeSeconds = 86_400): string {
  return `${VISITOR_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

/** A short, one-way label for a visitor id (the request log never carries the id itself). */
export function hashedVisitor(id: string | undefined): string | undefined {
  return id ? crypto.createHash("sha256").update(`kelly-visitor:${id}`).digest("hex").slice(0, 12) : undefined;
}

export interface PublicHistoryMessage {
  role: "visitor" | "kelly";
  text: string;
}

export interface Visitor {
  id: string;
  createdAt: number;
  lastSeen: number;
  history: PublicHistoryMessage[];
  turns: number;
  busy: boolean;
  /** Recent replies by id, so the talk page can ask for speech of a reply Kelly actually gave. */
  replies: Map<string, string>;
}

const MAX_REPLIES_KEPT = 6;

export class VisitorStore {
  private readonly visitors = new Map<string, Visitor>();

  constructor(private readonly options: { maxHistoryTurns: number; idleMs: number; maxVisitors: number }, private readonly now: () => number = Date.now) {}

  get size(): number { return this.visitors.size; }

  /** Visitors seen within `windowMs` (an aggregate count; nothing about who they are). */
  activeWithin(windowMs: number): number {
    const cutoff = this.now() - windowMs;
    let count = 0;
    for (const visitor of this.visitors.values()) if (visitor.busy || visitor.lastSeen >= cutoff) count += 1;
    return count;
  }

  get(id: string): Visitor | undefined {
    return this.visitors.get(id);
  }

  /** The visitor for this id, created when new. Evicts the longest-idle idle visitor at capacity. */
  ensure(id: string): { visitor: Visitor; created: boolean } {
    const existing = this.visitors.get(id);
    const at = this.now();
    if (existing) { existing.lastSeen = at; return { visitor: existing, created: false }; }
    if (this.visitors.size >= this.options.maxVisitors) {
      let evicted: Visitor | undefined;
      for (const candidate of this.visitors.values()) {
        if (candidate.busy) continue;
        if (!evicted || candidate.lastSeen < evicted.lastSeen) evicted = candidate;
      }
      if (evicted) this.visitors.delete(evicted.id);
    }
    const visitor: Visitor = { id, createdAt: at, lastSeen: at, history: [], turns: 0, busy: false, replies: new Map() };
    this.visitors.set(id, visitor);
    return { visitor, created: true };
  }

  /** Appends one exchange and keeps only the last `maxHistoryTurns` exchanges. */
  recordExchange(visitor: Visitor, message: string, reply: string, replyId: string): void {
    visitor.history.push({ role: "visitor", text: message }, { role: "kelly", text: reply });
    const maxMessages = this.options.maxHistoryTurns * 2;
    if (visitor.history.length > maxMessages) visitor.history.splice(0, visitor.history.length - maxMessages);
    visitor.turns += 1;
    visitor.lastSeen = this.now();
    visitor.replies.set(replyId, reply);
    while (visitor.replies.size > MAX_REPLIES_KEPT) visitor.replies.delete(visitor.replies.keys().next().value as string);
  }

  /** Starts a fresh conversation for this visitor. */
  resetConversation(visitor: Visitor): void {
    visitor.history = [];
    visitor.replies.clear();
    visitor.turns = 0;
  }

  /** Forgets every visitor idle for at least idleMs (never one mid-turn). Returns how many. */
  sweepIdle(): number {
    const cutoff = this.now() - this.options.idleMs;
    let removed = 0;
    for (const visitor of [...this.visitors.values()]) {
      if (!visitor.busy && visitor.lastSeen <= cutoff) { this.visitors.delete(visitor.id); removed += 1; }
    }
    return removed;
  }

  clear(): void { this.visitors.clear(); }
}

/* ---------------------------------------------------------------- *
 * Rate limiting and model-turn concurrency.
 * ---------------------------------------------------------------- */

/**
 * Sliding-window limiter. Keys are a visitor id and a client key; the client key is Cloudflare's
 * CF-Connecting-IP ONLY for requests that came through the tunnel (the edge sets it and a visitor
 * cannot), and the socket peer otherwise. It is used for rate limiting, never for authorization.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly windows: Array<{ ms: number; max: number }>, private readonly now: () => number = Date.now, private readonly maxKeys = 10_000) {}

  /** Records a hit and returns true, or returns false (recording nothing) when any window is full. */
  take(key: string): boolean {
    const at = this.now();
    const longest = Math.max(...this.windows.map((window) => window.ms));
    const recent = (this.hits.get(key) ?? []).filter((time) => at - time < longest);
    for (const window of this.windows) {
      if (recent.filter((time) => at - time < window.ms).length >= window.max) {
        this.hits.set(key, recent);
        return false;
      }
    }
    recent.push(at);
    this.hits.delete(key);
    this.hits.set(key, recent);
    while (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value as string);
    return true;
  }
}

/** A small counting semaphore with a bounded wait queue. */
export class ConcurrencyGate {
  private running = 0;
  private readonly waiting: Array<{ grant: () => void; timer: NodeJS.Timeout }> = [];

  constructor(private readonly max: number, private readonly maxQueue: number) {}

  get active(): number { return this.running; }
  get queued(): number { return this.waiting.length; }

  /**
   * Resolves to a release function once a slot is free, or null when the queue is full or the wait
   * exceeds `waitMs`. `onQueued` fires once if the caller has to wait.
   */
  acquire(waitMs: number, onQueued?: () => void): Promise<(() => void) | null> {
    const release = (): (() => void) => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.running -= 1;
        const next = this.waiting.shift();
        if (next) { clearTimeout(next.timer); next.grant(); }
      };
    };
    if (this.running < this.max) { this.running += 1; return Promise.resolve(release()); }
    if (this.waiting.length >= this.maxQueue) return Promise.resolve(null);
    onQueued?.();
    return new Promise((resolve) => {
      const entry = {
        grant: () => { this.running += 1; resolve(release()); },
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(entry);
          if (index !== -1) this.waiting.splice(index, 1);
          resolve(null);
        }, waitMs),
      };
      entry.timer.unref?.();
      this.waiting.push(entry);
    });
  }
}
