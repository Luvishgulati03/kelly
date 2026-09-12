import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import { istDateKey, istSessionKey, type StandupStore } from "./store.ts";

/**
 * Inbound Telegram reader for the STANDUP GROUP only. This module READS messages and
 * stores them — it executes nothing, routes nothing to the agent, and drops every
 * update that isn't a plain text message in the configured group. Remote control of
 * Henry stays a separate, explicitly-gated decision (docs/standup-module-design.md).
 *
 * Transport is `getUpdates` short-polling on an interval, not a held long-poll: this
 * laptop sleeps whenever the lid closes, and a 50s socket dies mid-sleep in ways that
 * need reconnect choreography. A cheap poll every minute survives sleep/wake for free,
 * and Telegram retains undelivered updates ~24h, so closed-lid gaps replay on wake.
 */

/** Refuse to poll when another live process refreshed the lock this recently. */
export const POLLER_LOCK_STALE_MS = 120_000;
const POLL_TIMEOUT_MS = 15_000;
const OFFSET_KEY = "poller:lastUpdateId";
const LOCK_KEY = "poller:lock";

interface TelegramChat { id: number; type?: string; title?: string; first_name?: string }
interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  chat?: TelegramChat;
  from?: { id: number; is_bot?: boolean; first_name?: string; username?: string };
  reply_to_message?: { from?: { id: number; is_bot?: boolean } };
}
interface TelegramUpdate { update_id: number; message?: TelegramMessage; edited_message?: TelegramMessage }

/**
 * What `consume()` did with one batch. `hold` means the batch must NOT be confirmed to
 * Telegram (offset stays put so it re-delivers) — today that only happens when the bot
 * identity is unresolved and the addressed-only rail therefore cannot run.
 */
export interface ConsumeResult { stored: number; hold?: boolean; reason?: string }

interface BotIdentity { id: number; username: string }

/**
 * ADDRESSED-ONLY RAIL: Henry stores a group message ONLY when it is explicitly
 * addressed to him — it starts with @<his-username> (case-insensitive), or it is
 * a direct reply to one of his own messages (answering a clarification he asked).
 * Everything else in the group is dropped unread and never persisted; teammates'
 * general chatter is not Henry's to keep.
 */
export function addressedText(message: TelegramMessage, identity: BotIdentity): string | undefined {
  const text = message.text ?? "";
  const mention = new RegExp(`^\\s*@${identity.username}\\b[\\s:,–—-]*`, "i");
  if (mention.test(text)) {
    const stripped = text.replace(mention, "").trim();
    return stripped || undefined;
  }
  if (message.reply_to_message?.from?.id === identity.id && message.reply_to_message.from.is_bot) {
    return text.trim() || undefined;
  }
  return undefined;
}

export interface PollResult {
  polled: boolean;
  reason?: string;
  stored: number;
  seenUpdates: number;
}

function isPidAlive(pid: number): boolean {
  // EPERM means the pid exists but belongs to another user — that's alive, not dead.
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export class StandupPoller {
  private interval?: ReturnType<typeof setInterval>;
  private loggedConflict = false;
  private loggedFailure = false;
  private identity?: BotIdentity;

  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    private readonly store: StandupStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * The bot's own id/username, needed for the addressed-only rail. Fetched once via
   * getMe and cached in meta so restarts (and offline boots) don't refetch.
   */
  private async ensureIdentity(): Promise<BotIdentity | undefined> {
    if (this.identity) return this.identity;
    const cached = this.store.getMeta("bot:identity");
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as BotIdentity;
        if (parsed.id && parsed.username) { this.identity = parsed; return parsed; }
      } catch { /* refetch below */ }
    }
    try {
      const response = await this.fetchImpl(`https://api.telegram.org/bot${this.config.telegramBotToken}/getMe`);
      const payload = await response.json() as { ok?: boolean; result?: { id?: number; username?: string } };
      if (payload.ok === true && payload.result?.id && payload.result.username) {
        this.identity = { id: payload.result.id, username: payload.result.username };
        this.store.setMeta("bot:identity", JSON.stringify(this.identity));
        return this.identity;
      }
    } catch { /* offline — try again next poll */ }
    return undefined;
  }

  get configured(): boolean {
    return Boolean(this.config.telegramBotToken && this.config.telegramStandupChatId);
  }

  /** The one chat this consumer owns — the shared pump's routing census reads it. */
  get chatId(): string | undefined { return this.config.telegramStandupChatId; }

  /** Consumer name in pump logs. */
  get name(): string { return "standup"; }

  /**
   * Single-consumer rail: Telegram serves `getUpdates` to ONE consumer per bot token
   * (a second gets 409s and both lose messages). The lock row names who may poll;
   * a stale or dead holder is taken over.
   */
  private tryAcquireLock(now: number = Date.now()): boolean {
    const raw = this.store.getMeta(LOCK_KEY);
    if (raw) {
      const [pidText, atText] = raw.split(":");
      const pid = Number(pidText);
      const at = Number(atText);
      const held = pid !== process.pid && Number.isFinite(pid) && isPidAlive(pid)
        && Number.isFinite(at) && now - at < POLLER_LOCK_STALE_MS;
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
   * One fetch-and-store cycle. Offset only advances after the batch is stored, so a
   * crash between fetch and store re-delivers rather than drops. Never throws.
   */
  async pollOnce(): Promise<PollResult> {
    if (!this.configured) return { polled: false, reason: "standup chat not configured", stored: 0, seenUpdates: 0 };
    if (!this.tryAcquireLock()) {
      if (!this.loggedConflict) {
        this.loggedConflict = true;
        await this.activity.record("workflow.completed", "Standup poller idle — another Henry process holds the poll lock", { standup: true });
      }
      return { polled: false, reason: "another process is polling", stored: 0, seenUpdates: 0 };
    }

    const lastId = Number(this.store.getMeta(OFFSET_KEY) ?? NaN);
    const params = new URLSearchParams({
      timeout: "0",
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
            await this.activity.record("workflow.failed", "Standup poller got 409 — another getUpdates consumer is using this bot token", { standup: true });
          }
          return { polled: false, reason: "telegram 409 (second consumer)", stored: 0, seenUpdates: 0 };
        }
        const payload = await response.json() as { ok?: boolean; result?: TelegramUpdate[] };
        if (!response.ok || payload.ok !== true || !Array.isArray(payload.result)) {
          return { polled: false, reason: `telegram error (${response.status})`, stored: 0, seenUpdates: 0 };
        }
        updates = payload.result;
        this.loggedFailure = false;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      if (!this.loggedFailure) {
        this.loggedFailure = true; // Offline is normal for a laptop — note it once, not every minute.
        await this.activity.record("workflow.failed", "Standup poll failed (offline?)", { standup: true, error: String(error) });
      }
      return { polled: false, reason: "network error", stored: 0, seenUpdates: 0 };
    }

    const outcome = await this.consume(updates);
    if (outcome.hold) return { polled: false, reason: outcome.reason, stored: 0, seenUpdates: updates.length };

    let maxUpdateId = Number.isFinite(lastId) ? lastId : -1;
    for (const update of updates) maxUpdateId = Math.max(maxUpdateId, update.update_id);
    if (maxUpdateId >= 0) this.store.setMeta(OFFSET_KEY, String(maxUpdateId));
    return { polled: true, stored: outcome.stored, seenUpdates: updates.length };
  }

  /**
   * The standup INTAKE, split out of `pollOnce` so a shared update pump (src/telegram/pump.ts)
   * can hand this module the exact same batch it used to fetch for itself — the transport moved,
   * the rails did not. Owns no offset and no lock: whoever fetched the batch confirms it.
   * Self-filters by chat id exactly as before, so a batch containing other chats is harmless.
   */
  async consume(updates: TelegramUpdate[]): Promise<ConsumeResult> {
    if (!this.configured) return { stored: 0 };
    const identity = await this.ensureIdentity();
    if (!identity) {
      // No identity = the addressed-only rail cannot run. Bail WITHOUT advancing the
      // offset (audit 2026-08-09 B-M1) — advancing made Telegram discard the whole
      // batch on the next poll, silently losing standups at the exact bootstrap
      // moment the backlog is largest.
      return { stored: 0, hold: true, reason: "bot identity unresolved (getMe failed) — batch left unconfirmed" };
    }
    let stored = 0;
    for (const update of updates) {
      const message = update.message ?? update.edited_message;
      if (!message?.text || !message.chat || !message.from) continue;
      if (String(message.chat.id) !== this.config.telegramStandupChatId) continue; // scope rail: the one group, nothing else
      if (message.from.is_bot) continue; // includes our own prompts/pings echoed back
      const text = addressedText(message, identity);
      if (!text) continue;
      const { fresh } = this.store.upsertUpdate({
        chatId: String(message.chat.id),
        messageId: message.message_id,
        userId: String(message.from.id),
        userName: message.from.first_name || message.from.username || `user-${message.from.id}`,
        date: istDateKey(message.date),
        session: istSessionKey(message.date),
        text,
        edited: Boolean(update.edited_message),
      });
      if (fresh) stored += 1;
    }
    return { stored };
  }

  /** Arms the interval poll inside a long-lived process (repl / scheduler daemon). No-op when unconfigured. */
  start(intervalMs = 60_000): boolean {
    if (!this.configured || this.interval) return false;
    // .catch is load-bearing: pollOnce's internal try only guards the fetch — a
    // SQLITE_BUSY from the store would otherwise be an unhandled rejection that
    // kills the host repl/daemon (audit 2026-08-09 L3, same crash class as H1).
    void this.pollOnce().catch(() => undefined);
    this.interval = setInterval(() => void this.pollOnce().catch(() => undefined), intervalMs);
    this.interval.unref?.();
    return true;
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    this.releaseLock();
  }

  /**
   * Group-id fishing for setup: lists the chats with pending (unconfirmed) updates,
   * WITHOUT advancing the offset. Works before `telegramStandupChatId` is configured —
   * add the bot to the group, have someone post once, then run `henry standup discover`.
   */
  async discoverChats(): Promise<Array<{ id: string; type: string; title: string }>> {
    if (!this.config.telegramBotToken) throw new Error("HENRY_TELEGRAM_BOT_TOKEN is not set");
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.config.telegramBotToken}/getUpdates?timeout=0`);
    const payload = await response.json() as { ok?: boolean; result?: TelegramUpdate[] };
    if (payload.ok !== true || !Array.isArray(payload.result)) throw new Error(`Telegram error (${response.status})`);
    const chats = new Map<string, { id: string; type: string; title: string }>();
    for (const update of payload.result) {
      const chat = (update.message ?? update.edited_message)?.chat;
      if (!chat) continue;
      chats.set(String(chat.id), { id: String(chat.id), type: chat.type ?? "unknown", title: chat.title || chat.first_name || "(untitled)" });
    }
    return [...chats.values()];
  }
}
