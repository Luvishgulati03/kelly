import type { HenryConfig } from "../config.ts";

/** Telegram hard-caps message bodies at this length. */
export const TELEGRAM_MAX_CHARS = 4096;
/** Wall-clock envelope for the sendMessage call — never let a flaky network hang a caller. */
export const TELEGRAM_TIMEOUT_MS = 10_000;

/**
 * SCOPE-GUARD: this is Luvish's operator-notification channel ONLY. `chat_id` is always read
 * from config (his own configured chat) — it is never accepted as a caller-supplied
 * parameter and this function must never grow into a general send-to-anyone surface.
 * Outbound messages to other people stay behind the ApprovalStore, exactly as today.
 *
 * Fails open: returns `false` on any missing config, network error, timeout, or non-2xx
 * response — never throws. Callers should treat Telegram delivery as best-effort on top of
 * the console/osascript notification path, not a replacement for it.
 */
export async function sendTelegram(config: HenryConfig, text: string): Promise<boolean> {
  if (!config.telegramBotToken || !config.telegramChatId) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    let body = text;
    if (body.length > TELEGRAM_MAX_CHARS) {
      let head = body.slice(0, TELEGRAM_MAX_CHARS - 1);
      // The slice can land mid-astral-char (emoji), leaving a lone high surrogate —
      // Telegram 400s the whole message and the notification silently vanishes.
      const last = head.charCodeAt(head.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
      body = `${head}…`;
    }
    const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: config.telegramChatId, text: body, disable_web_page_preview: true }),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
