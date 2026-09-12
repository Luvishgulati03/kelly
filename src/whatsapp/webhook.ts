import { isAllowedOwner } from "./owner.ts";
import { verifyWebhookSignature } from "./verification.ts";

export interface WhatsAppTextInboundMessage { id: string; from: string; text: string; timestamp?: string; wabaId?: string; phoneNumberId?: string; displayPhoneNumber?: string }
export interface WebhookLimits { maxRawBytes: number; maxEntries: number; maxChangesPerEntry: number; maxMessagesPerChange: number; maxTextChars: number }
export const DEFAULT_WEBHOOK_LIMITS: Readonly<WebhookLimits> = { maxRawBytes: 256_000, maxEntries: 20, maxChangesPerEntry: 20, maxMessagesPerChange: 100, maxTextChars: 4_096 };

/** Normalize only bounded text payloads. Any collection bound violation rejects the batch. */
export function normalizeWebhookPayload(payload: unknown, limits: WebhookLimits = DEFAULT_WEBHOOK_LIMITS): WhatsAppTextInboundMessage[] {
  if (!validLimits(limits) || !isRecord(payload) || payload.object !== "whatsapp_business_account" || !boundedArray(payload.entry, limits.maxEntries)) return [];
  const inbound: WhatsAppTextInboundMessage[] = [];
  for (const entry of payload.entry) {
    if (!isRecord(entry) || !boundedArray(entry.changes, limits.maxChangesPerEntry)) return [];
    const wabaId = typeof entry.id === "string" ? entry.id : undefined;
    for (const change of entry.changes) {
      if (!isRecord(change)) return [];
      if (change.field !== "messages") continue;
      if (!isRecord(change.value)) return [];
      const value = change.value;
      if (value.messages === undefined) continue; // Valid status-only delivery.
      if (!boundedArray(value.messages, limits.maxMessagesPerChange)) return [];
      const metadata = isRecord(value.metadata) ? value.metadata : undefined;
      for (const message of value.messages) {
        if (!isRecord(message) || message.type !== "text" || !isRecord(message.text)) continue;
        if (typeof message.id !== "string" || !message.id || typeof message.from !== "string" || !message.from || typeof message.text.body !== "string" || message.text.body.length > limits.maxTextChars) continue;
        inbound.push({ id: message.id, from: message.from, text: message.text.body,
          ...(typeof message.timestamp === "string" ? { timestamp: message.timestamp } : {}), ...(wabaId ? { wabaId } : {}),
          ...(metadata && typeof metadata.phone_number_id === "string" ? { phoneNumberId: metadata.phone_number_id } : {}),
          ...(metadata && typeof metadata.display_phone_number === "string" ? { displayPhoneNumber: metadata.display_phone_number } : {}),
        });
      }
    }
  }
  return inbound;
}

export interface AcceptedWebhookEnvelope extends WhatsAppTextInboundMessage { dedupeKey: string; wabaId: string; phoneNumberId: string }
export interface AtomicWebhookAcceptor {
  /** Atomically persist this envelope iff its dedupeKey is new; true means durable acceptance. */
  accept(envelope: AcceptedWebhookEnvelope): boolean;
}
export interface IngestWebhookOptions {
  signatureHeader: string | undefined | null; appSecret: string; expectedWabaId: string; expectedPhoneNumberId: string;
  allowedOwnerIds: readonly string[]; acceptor: AtomicWebhookAcceptor; limits?: Partial<WebhookLimits>;
}

/** Authenticate, bound, authorize, and atomically persist before releasing message bodies. */
export function ingestWebhook(rawBody: string | Buffer | Uint8Array, options: IngestWebhookOptions): AcceptedWebhookEnvelope[] {
  const limits = { ...DEFAULT_WEBHOOK_LIMITS, ...options.limits };
  if (!validLimits(limits) || rawByteLength(rawBody) > limits.maxRawBytes) return [];
  if (!verifyWebhookSignature(rawBody, options.signatureHeader, options.appSecret)) return [];
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(rawBody).toString("utf8")); } catch { return []; }
  const normalized = normalizeWebhookPayload(payload, limits);
  const accepted: AcceptedWebhookEnvelope[] = [];
  for (const message of normalized) {
    if (message.wabaId !== options.expectedWabaId || message.phoneNumberId !== options.expectedPhoneNumberId || !isAllowedOwner(message.from, options.allowedOwnerIds)) continue;
    const envelope: AcceptedWebhookEnvelope = { ...message, wabaId: message.wabaId, phoneNumberId: message.phoneNumberId, dedupeKey: `${message.wabaId}:${message.phoneNumberId}:${message.id}` };
    if (options.acceptor.accept(envelope)) accepted.push(envelope);
  }
  return accepted;
}

function rawByteLength(value: string | Buffer | Uint8Array): number { return typeof value === "string" ? Buffer.byteLength(value) : value.byteLength; }
function boundedArray(value: unknown, max: number): value is unknown[] { return Array.isArray(value) && value.length <= max; }
function validLimits(value: WebhookLimits): boolean { return Object.values(value).every((limit) => Number.isSafeInteger(limit) && limit >= 0); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
