/**
 * Telegram photo albums for the design gallery — a "designs" block resolved to shown
 * designs is followed by an owner-chat photo album, best effort. No dependency: the
 * multipart body is Node's built-in FormData/Blob, same mechanism sendTelegramVoiceNote
 * already uses (src/telegram/voice.ts). Never fails the text send: every error here
 * resolves to false.
 */

const TELEGRAM_MEDIA_TIMEOUT_MS = 30_000;
/** Telegram's own cap for a single sendMediaGroup call. */
export const MAX_ALBUM_PHOTOS = 10;

export interface AlbumPhoto {
  id: string;
  bytes: Buffer;
  mime: string;
  caption?: string;
}

/**
 * Sends up to 10 photos as one album to a single chat. `media` is a JSON array of
 * `{type:"photo", media:"attach://file<i>"}` objects (the first carries the caption);
 * each `attach://` name is backed by its own multipart part.
 */
export async function sendTelegramPhotoAlbum(
  input: { token: string; chatId: string; photos: AlbumPhoto[] },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const photos = input.photos.slice(0, MAX_ALBUM_PHOTOS);
  if (!photos.length) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_MEDIA_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append("chat_id", input.chatId);
    const media = photos.map((photo, index) => {
      const name = `file${index}`;
      const entry: Record<string, string> = { type: "photo", media: `attach://${name}` };
      if (index === 0 && photo.caption) entry.caption = photo.caption.slice(0, 1024);
      form.append(name, new Blob([new Uint8Array(photo.bytes)], { type: photo.mime }), `${photo.id}.${extFor(photo.mime)}`);
      return entry;
    });
    form.append("media", JSON.stringify(media));
    const response = await fetchImpl(`https://api.telegram.org/bot${input.token}/sendMediaGroup`, {
      method: "POST", body: form, signal: controller.signal, redirect: "error",
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function extFor(mime: string): string {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return "png";
}
