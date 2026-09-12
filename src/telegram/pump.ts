import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";

/**
 * THE SINGLE TELEGRAM UPDATE PUMP.
 *
 * Telegram serves `getUpdates` to exactly ONE consumer per bot token: a second consumer
 * gets 409s and, worse, silently steals updates the first one never sees. Henry now has
 * two things that want inbound messages on the same bot — the standup group intake and
 * Luvish's DM bridge — so the fetch itself moved here and the modules became CONSUMERS.
 * One socket, one offset, one lock; routing by chat id.
 *
 * Routing contract:
 *   - a consumer declares the ONE chat id it owns (`chatId`); undefined = unconfigured,
 *     and an unconfigured consumer is never called at all;
 *   - every configured consumer receives the WHOLE batch and self-filters by chat id,
 *     exactly the batch shape it used to fetch for itself (that is what keeps standup's
 *     behaviour and its tests bit-identical after the transport moved);
 *   - updates whose chat matches no consumer are COUNTED and dropped. Their text is
 *     never read, never logged, never stored.
 *
 * Doctrine rule 7: this file imports no module — consumers are injected by the runtime.
 * The offset/lock meta keys and the stale window are duplicated from standup/poller.ts on
 * purpose (same pattern as TELEGRAM_MAX_CHARS in standup/send.ts): they MUST be the same
 * strings so a legacy standup-only poller in another process can never poll beside the pump.
 */

export interface TelegramChat { id: number; type?: string; title?: string; first_name?: string }
export interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  chat?: TelegramChat;
  from?: { id: number; is_bot?: boolean; first_name?: string; username?: string };
  reply_to_message?: { from?: { id: number; is_bot?: boolean } };
}
export interface TelegramUpdate { update_id: number; message?: TelegramMessage; edited_message?: TelegramMessage }

/** Meta rows the pump persists through. `StandupStore` satisfies this structurally; tests pass a Map. */
export interface PumpMetaStore {
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  deleteMeta(key: string): void;
}

export interface ConsumeOutcome {
  /** Keep the batch UNCONFIRMED — the offset does not advance and Telegram re-delivers. */
  hold?: boolean;
  reason?: string;
}

export interface PumpConsumer {
  readonly name: string;
  /** The single chat id this consumer owns; undefined means unconfigured → never called. */
  readonly chatId: string | undefined;
  consume(updates: TelegramUpdate[]): Promise<ConsumeOutcome>;
}

/** Same keys as the legacy standup-only poller — see the header note. */
const OFFSET_KEY = "poller:lastUpdateId";
const LOCK_KEY = "poller:lock";
/** Refuse to poll when another live process refreshed the lock this recently. */
export const PUMP_LOCK_STALE_MS = 120_000;
/**
 * LONG POLL. Telegram holds `getUpdates` open until a message arrives (or this many
 * seconds pass), so a reply starts the moment Luvish hits send instead of waiting for the
 * next tick. It used to poll with `timeout=0` on a 60s interval, which meant ~30s of dead
 * air on average before Henry had even READ a message — far more than the thinking it was
 * blamed on.
 */
const LONG_POLL_SECONDS = 25;
/** Must comfortably exceed the long poll, or the abort fires mid-wait every single time. */
const POLL_TIMEOUT_MS = (LONG_POLL_SECONDS + 10) * 1_000;
/**
 * Only a gap between poll ATTEMPTS that returned nothing to wait on — a held lock, an
 * unconfigured token, a network error. A successful long poll re-arms immediately, because
 * the waiting already happened inside Telegram.
 */
export const DEFAULT_PUMP_INTERVAL_MS = 5_000;

export interface PumpResult {
  polled: boolean;
  reason?: string;
  seenUpdates: number;
  /** Per-consumer count of updates whose chat id matched — a census, not the consumers' own verdicts. */
  routed: Record<string, number>;
  /** Updates belonging to no configured chat. Counted only; content never touched. */
  ignored: number;
  /** True when a consumer asked to leave the batch unconfirmed. */
  held?: boolean;
}

function isPidAlive(pid: number): boolean {
  // EPERM means the pid exists but belongs to another user — that's alive, not dead.
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export class TelegramPump {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private loggedConflict = false;
  private loggedFailure = false;
  private ignoredTotal = 0;
  private loggedIgnored = 0;

  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    private readonly store: PumpMetaStore,
    private readonly consumers: PumpConsumer[],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Consumers with a chat id actually configured — the only ones that ever see a batch. */
  private get live(): PumpConsumer[] {
    return this.consumers.filter((consumer) => Boolean(consumer.chatId));
  }

  get configured(): boolean {
    return Boolean(this.config.telegramBotToken) && this.live.length > 0;
  }

  /**
   * Single-consumer rail, inherited from the standup poller: the lock row names who may
   * poll this bot token; a stale or dead holder is taken over.
   */
  private tryAcquireLock(now: number = Date.now()): boolean {
    const raw = this.store.getMeta(LOCK_KEY);
    if (raw) {
      const [pidText, atText] = raw.split(":");
      const pid = Number(pidText);
      const at = Number(atText);
      const held = pid !== process.pid && Number.isFinite(pid) && isPidAlive(pid)
        && Number.isFinite(at) && now - at < PUMP_LOCK_STALE_MS;
      if (held) return false;
    }
    this.store.setMeta(LOCK_KEY, `${process.pid}:${now}`);
    return true;
  }

  releaseLock(): void {
    const raw = this.store.getMeta(LOCK_KEY);
    if (raw?.startsWith(`${process.pid}:`)) this.store.deleteMeta(LOCK_KEY);
  }

  /**
   * One fetch-and-route cycle. The offset advances only AFTER every consumer has taken the
   * batch and none asked to hold, so a crash (or an unresolved bot identity) re-delivers
   * rather than drops. Never throws.
   */
  async pollOnce(): Promise<PumpResult> {
    const empty = { seenUpdates: 0, routed: {}, ignored: 0 };
    if (!this.config.telegramBotToken) return { polled: false, reason: "HENRY_TELEGRAM_BOT_TOKEN is not set", ...empty };
    if (this.live.length === 0) return { polled: false, reason: "no telegram consumers configured", ...empty };
    if (!this.tryAcquireLock()) {
      if (!this.loggedConflict) {
        this.loggedConflict = true;
        await this.activity.record("workflow.completed", "Telegram pump idle — another Henry process holds the poll lock", { telegram: true });
      }
      return { polled: false, reason: "another process is polling", ...empty };
    }

    const lastId = Number(this.store.getMeta(OFFSET_KEY) ?? NaN);
    const params = new URLSearchParams({
      timeout: String(LONG_POLL_SECONDS),
      allowed_updates: JSON.stringify(["message", "edited_message"]),
      ...(Number.isFinite(lastId) ? { offset: String(lastId + 1) } : {}),
    });

    let updates: TelegramUpdate[];
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
      try {
        const response = await this.fetchImpl(
          `https://api.telegram.org/bot${this.config.telegramBotToken}/getUpdates?${params}`,
          { signal: controller.signal },
        );
        if (response.status === 409) {
          if (!this.loggedConflict) {
            this.loggedConflict = true;
            await this.activity.record("workflow.failed", "Telegram pump got 409 — another getUpdates consumer is using this bot token", { telegram: true });
          }
          return { polled: false, reason: "telegram 409 (second consumer)", ...empty };
        }
        const payload = await response.json() as { ok?: boolean; result?: TelegramUpdate[] };
        if (!response.ok || payload.ok !== true || !Array.isArray(payload.result)) {
          return { polled: false, reason: `telegram error (${response.status})`, ...empty };
        }
        updates = payload.result;
        this.loggedFailure = false;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      if (!this.loggedFailure) {
        this.loggedFailure = true; // Offline is normal for a laptop — note it once, not every minute.
        await this.activity.record("workflow.failed", "Telegram poll failed (offline?)", { telegram: true, error: String(error) });
      }
      return { polled: false, reason: "network error", ...empty };
    }

    // Census first, purely from chat ids — no message text is inspected here.
    const owners = new Map<string, string>();
    for (const consumer of this.live) owners.set(String(consumer.chatId), consumer.name);
    const routed: Record<string, number> = {};
    let ignored = 0;
    for (const update of updates) {
      const chatId = (update.message ?? update.edited_message)?.chat?.id;
      const owner = chatId === undefined ? undefined : owners.get(String(chatId));
      if (owner) routed[owner] = (routed[owner] ?? 0) + 1;
      else ignored += 1;
    }

    let held = false;
    let holdReason: string | undefined;
    for (const consumer of this.live) {
      // Fail-open (doctrine rule 6): one consumer throwing must never stop the other from
      // getting its messages, and must never wedge the offset forever.
      try {
        const outcome = await consumer.consume(updates);
        if (outcome.hold) { held = true; holdReason = outcome.reason ?? `${consumer.name} held the batch`; }
      } catch (error) {
        await this.activity.record("workflow.failed", `Telegram consumer ${consumer.name} threw`, { telegram: true, error: String(error) });
      }
    }

    if (ignored > 0) {
      this.ignoredTotal += ignored;
      // Counter only — the chat id, sender, and text of an unknown chat are never recorded.
      // Logged on a widening cadence so a spam wave can't flood the activity log.
      if (this.ignoredTotal >= this.loggedIgnored * 2 || this.loggedIgnored === 0) {
        this.loggedIgnored = this.ignoredTotal;
        await this.activity.record("workflow.completed", `Telegram: ignored ${this.ignoredTotal} update(s) from chats Henry does not serve`, { telegram: true, ignoredTotal: this.ignoredTotal });
      }
    }

    if (held) return { polled: false, reason: holdReason, seenUpdates: updates.length, routed, ignored, held: true };

    let maxUpdateId = Number.isFinite(lastId) ? lastId : -1;
    for (const update of updates) maxUpdateId = Math.max(maxUpdateId, update.update_id);
    if (maxUpdateId >= 0) this.store.setMeta(OFFSET_KEY, String(maxUpdateId));
    return { polled: true, seenUpdates: updates.length, routed, ignored };
  }

  /** Total updates dropped for belonging to no served chat, this process. */
  get ignoredCount(): number { return this.ignoredTotal; }

  /** Arms the interval poll inside a long-lived process (repl / scheduler daemon). No-op when unconfigured. */
  /**
   * Arms a self-rescheduling long poll. A fixed interval cannot work with long polling:
   * the poll itself already blocks for up to LONG_POLL_SECONDS, so a timer would either
   * stack overlapping requests or leave dead air after each one. Instead each cycle
   * schedules the next when it finishes — immediately after a real poll (the waiting
   * happened inside Telegram), and after `intervalMs` when there was nothing to wait on,
   * so a held lock or a missing token cannot become a hot loop.
   */
  start(intervalMs = DEFAULT_PUMP_INTERVAL_MS): boolean {
    if (!this.configured || this.running) return false;
    this.running = true;
    const cycle = async (): Promise<void> => {
      if (!this.running) return;
      // .catch is load-bearing: pollOnce's internal try only guards the fetch — a
      // SQLITE_BUSY from the store would otherwise be an unhandled rejection that
      // kills the host repl/daemon (audit 2026-08-09 L3).
      const result = await this.pollOnce().catch(() => undefined);
      if (!this.running) return;
      this.timer = setTimeout(() => void cycle(), result?.polled ? 0 : intervalMs);
      this.timer.unref?.();
    };
    void cycle();
    return true;
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.releaseLock();
  }
}
