import { isAllowedOwner } from "./owner.ts";

export interface RelayInboxEvent { eventId: string; leaseToken: string; kind: "message.received"; metaMessageId: string; phoneNumberId: string; senderId: string; receivedAt: string; message: { type: "text"; text: string } }
export type RelayDisposition = "processed" | "unsupported" | "rejected";
export interface LeaseOptions { waitSeconds?: number; maxEvents?: number }
export interface ApprovedTextExecution { approvalId: string; executionKey: string; recipientId: string; replyToMessageId: string; body: string; lastInboundAt: string; checkedAt: string }
export type RelayOutboxState = "accepted" | "submitted" | "sent" | "delivered" | "read" | "failed" | "uncertain";
export interface RelayOutboxResult { protocolVersion: 1; executionKey: string; state: RelayOutboxState; metaMessageId?: string }
export interface WhatsAppRelayClientOptions { baseUrl: string; authToken: string; ownerIds: readonly string[]; expectedPhoneNumberId: string; fetchImpl: typeof fetch; allowInsecureForTests?: boolean }

/** Closed, authenticated client for the documented WhatsApp relay protocol. */
export class WhatsAppRelayClient {
  private readonly baseUrl: URL;
  constructor(private readonly options: WhatsAppRelayClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    if (this.baseUrl.protocol !== "https:" && !options.allowInsecureForTests) throw new Error("WhatsApp relay URL must use HTTPS");
    if (!options.authToken) throw new Error("WhatsApp relay authentication token is required");
    if (!options.expectedPhoneNumberId) throw new Error("Expected WhatsApp phone-number ID is required");
  }

  async poll(options: LeaseOptions = {}): Promise<RelayInboxEvent[]> {
    const body = await this.request("/v1/inbox/lease", { method: "POST", body: JSON.stringify({ protocolVersion: 1, ...(options.waitSeconds === undefined ? {} : { waitSeconds: options.waitSeconds }), ...(options.maxEvents === undefined ? {} : { maxEvents: options.maxEvents }) }) });
    if (!hasExactKeys(body, ["protocolVersion", "events"]) || body.protocolVersion !== 1 || !Array.isArray(body.events) || !body.events.every(isRelayInboxEvent)) throw protocolError();
    if (!body.events.every((event) => isAllowedOwner(event.senderId, this.options.ownerIds) && event.phoneNumberId === this.options.expectedPhoneNumberId)) throw new Error("WhatsApp relay returned an unauthorized inbox event");
    return body.events;
  }

  async ack(event: Pick<RelayInboxEvent, "eventId" | "leaseToken">, disposition: RelayDisposition): Promise<void> {
    if (!nonEmpty(event.eventId) || !nonEmpty(event.leaseToken) || !(["processed", "unsupported", "rejected"] as const).includes(disposition)) throw new Error("Invalid WhatsApp relay acknowledgement");
    const body = await this.request(`/v1/inbox/${encodeURIComponent(event.eventId)}/ack`, { method: "POST", body: JSON.stringify({ protocolVersion: 1, leaseToken: event.leaseToken, disposition }) }, true);
    if (body !== undefined && (!hasExactKeys(body, ["protocolVersion", "eventId", "disposition"]) || body.protocolVersion !== 1 || body.eventId !== event.eventId || body.disposition !== disposition)) throw protocolError();
  }

  async sendApprovedText(execution: ApprovedTextExecution): Promise<RelayOutboxResult> {
    if (!isAllowedOwner(execution.recipientId, this.options.ownerIds)) throw new Error("WhatsApp outbox recipient is not an allowed owner");
    if (!Object.values(execution).every(nonEmpty)) throw new Error("Invalid approved WhatsApp text execution");
    const requestBody = { protocolVersion: 1, executionKey: execution.executionKey, approvalId: execution.approvalId, recipientId: execution.recipientId, replyToMessageId: execution.replyToMessageId, message: { type: "text", text: execution.body }, window: { lastInboundAt: execution.lastInboundAt, checkedAt: execution.checkedAt } };
    const body = await this.request("/v1/outbox", { method: "POST", body: JSON.stringify(requestBody) });
    if (!isOutboxResult(body) || body.executionKey !== execution.executionKey) throw protocolError();
    return body;
  }

  private async request(path: string, init: RequestInit, allowEmpty = false): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.options.authToken}`); headers.set("accept", "application/json"); headers.set("content-type", "application/json"); headers.set("henry-relay-version", "1");
    const response = await this.options.fetchImpl(new URL(path, this.baseUrl), { ...init, headers });
    if (!response.ok) throw new Error(`WhatsApp relay request failed (${response.status})`);
    if (allowEmpty && (response.status === 204 || response.headers.get("content-length") === "0")) return undefined;
    try { return await response.json(); } catch { throw protocolError(); }
  }
}

function isRelayInboxEvent(value: unknown): value is RelayInboxEvent {
  if (!hasExactKeys(value, ["eventId", "leaseToken", "kind", "metaMessageId", "phoneNumberId", "senderId", "receivedAt", "message"])) return false;
  if (![value.eventId, value.leaseToken, value.metaMessageId, value.phoneNumberId, value.senderId, value.receivedAt].every(nonEmpty)) return false;
  return value.kind === "message.received" && hasExactKeys(value.message, ["type", "text"]) && value.message.type === "text" && typeof value.message.text === "string";
}
function isOutboxResult(value: unknown): value is RelayOutboxResult {
  if (!isRecord(value)) return false;
  const permitted = value.metaMessageId === undefined ? ["executionKey", "protocolVersion", "state"] : ["executionKey", "metaMessageId", "protocolVersion", "state"];
  return Object.keys(value).sort().join() === permitted.sort().join() && value.protocolVersion === 1 && nonEmpty(value.executionKey) && (["accepted", "submitted", "sent", "delivered", "read", "failed", "uncertain"] as const).includes(value.state as RelayOutboxState) && (value.metaMessageId === undefined || nonEmpty(value.metaMessageId));
}
function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> { return isRecord(value) && Object.keys(value).sort().join() === [...keys].sort().join(); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function protocolError(): Error { return new Error("WhatsApp relay returned an invalid protocol response"); }
