import type { HenryConfig } from "../config.ts";

/** Telegram hard-caps message bodies at this length (same constant as notify/telegram.ts — kept local, doctrine rule 7). */
const TELEGRAM_MAX_CHARS = 4096;
const TELEGRAM_TIMEOUT_MS = 10_000;

/**
 * SCOPE-GUARD: this is the STANDUP GROUP surface ONLY — the second of exactly two
 * pre-authorized Telegram sends (the other is `notify/telegram.ts`, pinned to Luvish's
 * own DM). `chat_id` is always read from config (`telegramStandupChatId`) — never
 * caller-supplied — and this function must never grow into a general send-to-anyone
 * surface. Outbound to any other destination stays behind the ApprovalStore.
 *
 * Fails open like the DM sender: returns `false` on missing config, network error,
 * timeout, or non-2xx — never throws. Standup pings are best-effort.
 */
export async function sendStandupMessage(config: HenryConfig, text: string, replyToMessageId?: number): Promise<boolean> {
  if (!config.telegramBotToken || !config.telegramStandupChatId) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    let body = text;
    if (body.length > TELEGRAM_MAX_CHARS) {
      let head = body.slice(0, TELEGRAM_MAX_CHARS - 1);
      // The slice can land mid-astral-char (emoji), leaving a lone high surrogate —
      // Telegram 400s the whole message and the ping silently vanishes (same guard
      // as notify/telegram.ts — kept local, doctrine rule 7).
      const last = head.charCodeAt(head.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
      body = `${head}…`;
    }
    const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegramStandupChatId,
        text: body,
        disable_web_page_preview: true,
        // Threaded clarifications: replying to the vague update keeps the nudge scoped
        // to its author instead of reading as a broadcast. Absent for prompts/summaries.
        ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}),
      }),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export type StandupSender = typeof sendStandupMessage;
