import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import { readSettings } from "../util/settings.ts";
import { reflexKind, renderReflex, type ReflexKind, type ReflexSnapshot } from "../reflex.ts";
import type { ConsumeOutcome, PumpConsumer, PumpMetaStore, TelegramUpdate } from "./pump.ts";

export { reflexKind, renderReflex, type ReflexKind, type ReflexSnapshot } from "../reflex.ts";

/**
 * THE DM BRIDGE — Luvish texts the bot, Henry thinks, Henry replies in the chat.
 *
 * Rails, in the order they bite:
 *
 * 1. LUVISH-ONLY. The only chat this consumer ever reads or answers is
 *    `telegramChatId` — Luvish's own DM, read from config, never caller-supplied.
 *    Any other DM gets NO reply, ever; the pump counts it and the text is never read,
 *    logged, or stored. Replying to Luvish is not an outbound third-party send (soul.md
 *    "hard outbound boundary" governs messages to ANYONE ELSE, and still does: everything
 *    Henry decides to do from this conversation runs the normal rails).
 * 2. CONVERSATION BY DEFAULT. Optional operator mode allows local engineering and research
 *    from Telegram, but keeps external/destructive actions behind their existing rails.
 * 3. ONE IN FLIGHT. Messages are processed strictly sequentially (one M1 Air, one brain).
 *    At most 5 queue behind; older ones are dropped with a note in the next reply.
 * 4. KILL SWITCH. `telegram.bridge.enabled: false` in data/settings.json switches the
 *    bridge off instantly — read fresh per poll, never cached. Default ON when
 *    HENRY_TELEGRAM_BOT_TOKEN + HENRY_TELEGRAM_CHAT_ID are both present.
 *
 * Doctrine rule 7: this file imports no module. The sender (`notify/telegram.ts`, already
 * pinned to Luvish's DM) and the brain entry (`HenryAgent.run`) are injected by runtime.ts,
 * so the bridge adds ZERO new outbound surfaces and ZERO new brains.
 */

/** Telegram hard-caps message bodies at this length (same constant as notify/telegram.ts — kept local, doctrine rule 7). */
export const TELEGRAM_MAX_CHARS = 4096;
/** How many messages may wait behind the in-flight one before the oldest are dropped. */
export const BRIDGE_MAX_PENDING = 5;
/** Telegram retains undelivered updates ~24h; anything older than that is a backlog pathology, not a conversation. */
export const BRIDGE_STALE_MS = 24 * 60 * 60 * 1000;
/** Telegram clears a typing indicator after ~5s, so refresh a little faster than that. */
const TYPING_REFRESH_MS = 4_000;
const HANDLED_KEY = "bridge:lastUpdateId";
/**
 * The one turn that was interrupted by a provider running out of quota. Persisted (not held
 * in memory) so it survives the restart that a quota wall often prompts, and singular on
 * purpose: keeping a backlog of stale asks would be worse than keeping the last one.
 */
const DEFERRED_KEY = "bridge:deferredTurn";

const TERMINAL_ONLY_REPLY = [
  "That one belongs in the terminal session, not here 🙂",
  "",
  "The Telegram bridge runs me READ-ONLY on purpose — it's for talking, not for changing the repo, spending a long run, or pushing anything. Open the repl (`henry repl`) and ask me there; I'll do it properly, with the usual approvals.",
].join("\n");

/** Questions ABOUT the repo are conversation; only imperatives get deferred to the terminal. */
const QUESTION = /^\s*(what|why|how|when|who|where|which|did|do|does|is|are|was|were|can|could|should|would|any)\b/i;

const TERMINAL_ONLY_PATTERNS: Array<[RegExp, string]> = [
  [/\bgit\s+(push|commit|rebase|reset|merge|revert|cherry-pick|stash)\b/i, "git state change"],
  [/\brm\s+-rf\b|\bdrop\s+(the\s+)?(table|database|db)\b/i, "destructive command"],
  [/\bnpm\s+(install|i|ci|run\s+build)\b|\byarn\s+add\b|\bpnpm\s+(add|install)\b/i, "dependency install"],
  [/\b(deploy|ship it|publish|release)\b/i, "deploy"],
  [/\brun\s+(the\s+)?(full\s+)?(tests?|test\s+suite|typecheck|suite|build)\b|\bnpm\s+test\b/i, "long-running check"],
  [/\bknowledge\s+add\b|\bbackfill\b|\bjobs\s+login\b|\b(scout|crawl|reindex|re-index|ingest)\b/i, "long-running pipeline"],
  [/\b(refactor|rewrite|implement|patch|edit|modify|delete|remove|fix|change|update|add)\b[\s\S]{0,60}\b(repo|repository|codebase|code\s?base|module|file|files|function|class|test|tests|dashboard|cli|schema)\b/i, "repo edit"],
];

/**
 * Names why a message must go to the terminal instead of the bridge, or undefined when it
 * is ordinary conversation. Deliberately narrow: over-blocking would make the bridge
 * useless, and the readOnly sandbox is the actual enforcement — this is the polite door.
 */
export function terminalOnlyReason(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (QUESTION.test(trimmed) && trimmed.includes("?")) return undefined;
  for (const [pattern, reason] of TERMINAL_ONLY_PATTERNS) if (pattern.test(trimmed)) return reason;
  return undefined;
}

/** Operator mode can edit/test locally, but never turns Telegram into an outbound shell. */
export function operatorTerminalOnlyReason(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (/\bgit\s+(push|merge|rebase|reset|revert|cherry-pick)\b|\b(deploy|ship it|publish|release)\b|\b(approve|send|post|reply)\b/i.test(trimmed)) return "external or high-risk action";
  if (/\brm\s+-rf\b|\bdrop\s+(the\s+)?(table|database|db)\b/i.test(trimmed)) return "destructive command";
  return undefined;
}

/**
 * Splits a reply into Telegram-sized messages, preferring a paragraph or word boundary in
 * the back half of each window and never splitting a surrogate pair (a lone high surrogate
 * makes Telegram 400 the whole message — same failure notify/telegram.ts guards against).
 */
export function chunkTelegramText(text: string, max = TELEGRAM_MAX_CHARS): string[] {
  if (max < 1) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = max;
    const window = rest.slice(0, max);
    const newline = window.lastIndexOf("\n");
    const space = window.lastIndexOf(" ");
    if (newline > max / 2) cut = newline + 1;
    else if (space > max / 2) cut = space + 1;
    const last = rest.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
    if (cut < 1) cut = max;
    const piece = rest.slice(0, cut).trimEnd();
    if (piece) chunks.push(piece);
    rest = rest.slice(cut);
  }
  if (rest.trim()) chunks.push(rest.trimEnd());
  return chunks.length ? chunks : [];
}

/**
 * Kill switch. Absent settings mean ON — the bridge is the default behaviour once the two
 * env vars exist; only an explicit `false` turns it off, and OFF wins instantly.
 */
export function bridgeEnabled(settingsPath: string): boolean {
  const telegram = readSettings(settingsPath).telegram;
  if (typeof telegram !== "object" || telegram === null || Array.isArray(telegram)) return true;
  const bridge = (telegram as Record<string, unknown>).bridge;
  if (typeof bridge !== "object" || bridge === null || Array.isArray(bridge)) return true;
  return (bridge as Record<string, unknown>).enabled !== false;
}

export interface BridgeStats {
  replies: number;
  /** Answered from local state with no provider call — see the reflex lane below. */
  reflex: number;
  /** Turns picked back up after a quota wall. */
  resumed: number;
  /** Turns parked because every provider was out of quota. */
  deferredByLimit: number;
  deferred: number;
  dropped: number;
  stale: number;
  failed: number;
  queued: number;
  thinking: boolean;
}

/**
 * Everything the reflex lane can answer WITHOUT a provider call. Supplied by the runtime,
 * because the bridge owns no stores (doctrine rule 7) — and kept deliberately small: this
 * is the set of questions whose answer is already sitting in local state.
 */
export interface BridgeDeps {
  /** The ONE brain entry — runtime.ts wires this to HenryAgent.run (readOnly, telegram surface). */
  think: (prompt: string, report: (text: string) => Promise<boolean>) => Promise<string>;
  /** The existing DM sender, already pinned to Luvish's chat id. Injected: the bridge owns no send surface. */
  send: (config: HenryConfig, text: string) => Promise<boolean>;
  /**
   * Local state for the reflex lane. Optional: without it every message simply takes the
   * ordinary path, so an older wiring keeps working unchanged.
   */
  snapshot?: () => Promise<ReflexSnapshot>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * THE REFLEX LANE.
 *
 * "What are you working on?" is not a question for a language model — the answer is sitting
 * in the dispatch registry and the approval store. Routing it through the brain meant it
 * queued behind whatever long turn was in flight and then cost a CLI spawn to read back
 * local state.
 *
 * These are answered inline, concurrently, and NEVER enter the sequential queue, so Henry
 * stays reachable as an orchestrator while a heavy turn runs. Kept narrow on purpose: a
 * pattern here must be one whose answer is entirely local and unambiguous. Anything with a
 * hint of interpretation belongs to the brain.
 */
interface Pending { updateId: number; text: string }

export class TelegramBridge implements PumpConsumer {
  readonly name = "bridge";
  private readonly queue: Pending[] = [];
  private draining?: Promise<void>;
  private droppedSinceLastReply = 0;
  private counters = { replies: 0, deferred: 0, dropped: 0, stale: 0, failed: 0, reflex: 0, resumed: 0, deferredByLimit: 0 };
  /** Reflex answers run outside the sequential queue; `settled()` still has to wait for them. */
  private readonly reflexInFlight = new Set<Promise<void>>();
  private thinking = false;

  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    private readonly store: PumpMetaStore,
    private readonly deps: BridgeDeps,
  ) {}

  /** Both env vars present — without them there is no bot and no known Luvish. */
  get configured(): boolean {
    return Boolean(this.config.telegramBotToken && this.config.telegramChatId);
  }

  /** Configured AND not killed in settings. Read fresh: the switch must bite mid-run. */
  get enabled(): boolean {
    return this.configured && bridgeEnabled(this.config.settingsPath);
  }

  get operatorMode(): boolean { return this.config.telegramOperatorMode; }

  /**
   * The pump routes by this. Returning undefined while disabled is the kill switch's teeth:
   * the pump then never hands this consumer a batch at all, and standup keeps polling fine.
   */
  get chatId(): string | undefined {
    return this.enabled ? this.config.telegramChatId : undefined;
  }

  stats(): BridgeStats {
    return { ...this.counters, queued: this.queue.length, thinking: this.thinking };
  }

  /**
   * Pump entry. Enqueues Luvish's new messages and returns IMMEDIATELY — a brain call takes
   * tens of seconds and must never hold the shared poll (standup would starve behind it).
   * Never holds the batch: a bridge failure is a lost reply, not a lost standup.
   */
  async consume(updates: TelegramUpdate[]): Promise<ConsumeOutcome> {
    if (!this.enabled) return {};
    const mine = this.config.telegramChatId;
    const now = this.deps.now?.() ?? Date.now();
    const lastHandled = Number(this.store.getMeta(HANDLED_KEY) ?? NaN);
    let maxSeen = Number.isFinite(lastHandled) ? lastHandled : -1;

    for (const update of updates) {
      const message = update.message ?? update.edited_message;
      const chatId = message?.chat?.id;
      if (chatId === undefined || String(chatId) !== mine) continue; // LUVISH-ONLY rail
      // Everything below is already known to be Luvish's own chat.
      maxSeen = Math.max(maxSeen, update.update_id);
      if (Number.isFinite(lastHandled) && update.update_id <= lastHandled) continue; // replayed batch
      if (!message?.text || message.from?.is_bot) continue; // stickers, photos, our own echoes
      if (now - message.date * 1000 > BRIDGE_STALE_MS) { this.counters.stale += 1; continue; }
      const text = message.text.trim();
      if (!text) continue;
      // REFLEX FIRST, and deliberately outside the queue: a question about local state
      // must not wait behind a brain call that may run for a minute. This is what keeps
      // Henry answerable while he is busy.
      // RESUME FIRST. A turn parked by a quota wall goes back at the FRONT of the queue
      // before this new message is queued behind it, so the work Luvish already asked for
      // finishes before the thing he just said — which is the order he asked them in.
      this.resumeDeferred();
      const reflex = this.deps.snapshot ? reflexKind(text) : undefined;
      if (reflex) {
        const pending = this.answerReflex(reflex).catch(() => undefined).finally(() => { this.reflexInFlight.delete(pending); });
        this.reflexInFlight.add(pending);
        continue;
      }
      this.enqueue({ updateId: update.update_id, text });
    }

    // Written BEFORE the reply lands on purpose: a crash mid-think costs one answer, while
    // the alternative (confirm after replying) costs a duplicate reply on every restart.
    if (maxSeen >= 0) this.store.setMeta(HANDLED_KEY, String(maxSeen));
    void this.drain().catch(() => undefined);
    return {};
  }

  /**
   * Answers from local state and replies straight away. Runs concurrently with whatever the
   * sequential lane is doing, and touches no provider, so it costs nothing but a Telegram
   * send. A snapshot failure falls back to the ordinary lane rather than going silent.
   */
  private async answerReflex(kind: ReflexKind): Promise<void> {
    try {
      const snapshot = await this.deps.snapshot!();
      const sent = await this.reply(renderReflex(kind, snapshot, this.deps.now?.() ?? Date.now()));
      this.counters.reflex += 1;
      if (sent) this.counters.replies += 1;
      await this.activity.record("run.completed", `Telegram bridge answered a ${kind} ask from local state`, { telegram: true, reflex: kind });
    } catch (error) {
      this.counters.failed += 1;
      await this.activity.record("run.failed", "Telegram reflex answer failed", { telegram: true, error: String(error) }).catch(() => undefined);
    }
  }

  /**
   * Puts a quota-parked turn back at the FRONT of the queue, once. Cleared as it is taken,
   * so a turn can be parked again if quota is still gone but can never be replayed twice.
   */
  private resumeDeferred(): void {
    const raw = this.store.getMeta(DEFERRED_KEY);
    if (!raw) return;
    this.store.deleteMeta(DEFERRED_KEY);
    try {
      const parsed = JSON.parse(raw) as Pending;
      if (parsed && typeof parsed.text === "string" && parsed.text.trim()) {
        this.queue.unshift(parsed);
        this.counters.resumed += 1;
      }
    } catch { /* an unreadable row is dropped rather than poisoning every future poll */ }
  }

  /** Parks the turn for the next message to pick up, and says so instead of pretending it failed. */
  private async deferTurn(item: Pending, reason: string): Promise<void> {
    this.counters.deferredByLimit += 1;
    try { this.store.setMeta(DEFERRED_KEY, JSON.stringify(item)); } catch { /* best effort */ }
    await this.activity.record("run.failed", "Telegram turn parked — provider out of quota", { telegram: true, reason }).catch(() => undefined);
    await this.reply(`I'm out of provider quota right now, so I haven't answered that yet.\n\nI've kept your message — send me anything when quota is back and I'll finish this one first.`);
  }

  private enqueue(item: Pending): void {
    this.queue.push(item);
    while (this.queue.length > BRIDGE_MAX_PENDING) {
      this.queue.shift();
      this.droppedSinceLastReply += 1;
      this.counters.dropped += 1;
    }
  }

  /**
   * Resolves once the queue is empty and nothing is in flight — INCLUDING reflex answers,
   * which run outside the queue. "Settled" has to mean settled, or `telegram status` and
   * every test would report done while a reply was still on its way out.
   */
  async settled(): Promise<void> {
    while (this.draining || this.reflexInFlight.size > 0) {
      if (this.draining) await this.draining.catch(() => undefined);
      if (this.reflexInFlight.size > 0) await Promise.allSettled([...this.reflexInFlight]);
    }
  }

  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.loop().finally(() => { this.draining = undefined; });
    return this.draining;
  }

  /** STRICTLY sequential: exactly one brain call in flight, ever. */
  private async loop(): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue.shift() as Pending;
      const dropped = this.droppedSinceLastReply;
      this.droppedSinceLastReply = 0;
      const note = dropped
        ? `(dropped ${dropped} earlier message${dropped === 1 ? "" : "s"} while I was thinking — resend if they mattered)\n\n`
        : "";
      try {
        await this.handle(item, note);
      } catch (error) {
        this.counters.failed += 1;
        await this.activity.record("run.failed", "Telegram bridge turn failed", { telegram: true, error: String(error) }).catch(() => undefined);
      }
    }
  }

  private async handle(item: Pending, note: string): Promise<void> {
    const deferral = this.operatorMode ? operatorTerminalOnlyReason(item.text) : terminalOnlyReason(item.text);
    if (deferral) {
      this.counters.deferred += 1;
      await this.reply(`${note}${TERMINAL_ONLY_REPLY}`);
      await this.activity.record("workflow.completed", `Telegram bridge deferred a ${deferral} ask to the terminal`, { telegram: true, reason: deferral });
      return;
    }

    const stopTyping = this.startTyping();
    this.thinking = true;
    let answer = "";
    try {
      // A delegated worker can call `report` later, after this foreground turn
      // has already acknowledged and released the inbound queue. Reuse reply()
      // so long reports are chunked safely instead of Telegram-truncated.
      answer = (await this.deps.think(item.text, (text) => this.reply(text))).trim();
    } catch (error) {
      // Out of quota is not a failed answer — it is an unanswered question. Park it and say
      // so, rather than burning the turn with "say it again": the message Luvish already
      // sent is exactly the thing he wants finished when capacity comes back.
      if (error && typeof error === "object" && (error as { deferrable?: boolean }).deferrable === true) {
        this.thinking = false;
        stopTyping();
        await this.deferTurn(item, String((error as Error).message ?? "provider limit"));
        return;
      }
      this.counters.failed += 1;
      await this.activity.record("run.failed", "Telegram bridge brain call failed", { telegram: true, error: String(error) }).catch(() => undefined);
    } finally {
      this.thinking = false;
      stopTyping();
    }
    if (!answer) answer = "I hit an error thinking about that one — say it again, or grab me in the terminal.";
    const sent = await this.reply(`${note}${answer}`);
    if (sent) this.counters.replies += 1; else this.counters.failed += 1;
    await this.activity.record(sent ? "run.completed" : "run.failed", `Telegram bridge ${sent ? "replied to" : "failed to reach"} Luvish`, {
      telegram: true, chars: answer.length,
    });
  }

  /** Chunked to Telegram's hard cap and sent in order; the first failure stops the rest. */
  private async reply(text: string): Promise<boolean> {
    const chunks = chunkTelegramText(text);
    if (chunks.length === 0) return true;
    for (const chunk of chunks) {
      const ok = await this.deps.send(this.config, chunk);
      if (!ok) return false;
    }
    return true;
  }

  /**
   * "Henry is typing…" while the brain runs. Best-effort and fire-and-forget: a failed
   * chat action must never affect the reply. Pinned to Luvish's own chat like everything here.
   */
  private startTyping(): () => void {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    if (!this.config.telegramBotToken || !this.config.telegramChatId) return () => undefined;
    const ping = () => {
      void Promise.resolve()
        .then(() => fetchImpl(`https://api.telegram.org/bot${this.config.telegramBotToken}/sendChatAction`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: this.config.telegramChatId, action: "typing" }),
        }))
        .catch(() => undefined);
    };
    ping();
    const timer = setInterval(ping, TYPING_REFRESH_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}
