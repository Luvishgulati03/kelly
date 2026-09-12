import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { DEFAULT_WEBHOOK_LIMITS, ingestWebhook, isAllowedOwner, normalizeWebhookPayload, requireAllowedOwner, verifyMetaChallenge, verifyWebhookSignature, WhatsAppRelayClient, type AcceptedWebhookEnvelope } from "../src/whatsapp/index.ts";

const sign = (raw: Buffer) => `sha256=${crypto.createHmac("sha256", "app-secret").update(raw).digest("hex")}`;
const event = { eventId: "evt_1", leaseToken: "lease_1", kind: "message.received", metaMessageId: "wamid.1", phoneNumberId: "phone-1", senderId: "owner", receivedAt: "2030-01-01T00:00:00.000Z", message: { type: "text", text: "hello" } } as const;

test("Meta challenge rejects empty values and requires exact token", () => {
  assert.equal(verifyMetaChallenge("subscribe", "secret", "challenge", "secret"), "challenge");
  assert.equal(verifyMetaChallenge("subscribe", "", "challenge", ""), null);
  assert.equal(verifyMetaChallenge("subscribe", "secret", "", "secret"), null);
  assert.equal(verifyMetaChallenge("unsubscribe", "secret", "challenge", "secret"), null);
});

test("webhook signature verifies exact raw bytes and rejects malformed signatures", () => {
  const raw = Buffer.from('{"body":"💚"}');
  assert.equal(verifyWebhookSignature(raw, sign(raw), "app-secret"), true);
  assert.equal(verifyWebhookSignature(Buffer.from('{"body": "💚"}'), sign(raw), "app-secret"), false);
  assert.equal(verifyWebhookSignature(raw, "sha256=xyz", "app-secret"), false);
  assert.equal(verifyWebhookSignature(raw, null, "app-secret"), false);
});

test("normalizer handles batches while ignoring statuses and unsupported messages", () => {
  const payload = { object: "whatsapp_business_account", entry: [{ id: "waba-1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "phone-1" }, statuses: [{ id: "sent" }], messages: [{ id: "m1", from: "owner", type: "text", text: { body: "one" } }, { id: "m2", from: "owner", type: "image" }] } }] }, { id: "waba-1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "phone-1" }, messages: [{ id: "m3", from: "owner", type: "text", text: { body: "two" } }] } }] }] };
  assert.deepEqual(normalizeWebhookPayload(payload).map(({ id, text }) => ({ id, text })), [{ id: "m1", text: "one" }, { id: "m3", text: "two" }]);
});

test("owner allowlist rejects lookalikes and unknown identities", () => {
  assert.equal(isAllowedOwner("919999999999", ["919999999999"]), true);
  assert.equal(isAllowedOwner("+919999999999", ["919999999999"]), false);
  assert.throws(() => requireAllowedOwner("stranger", ["owner"]), /not an allowed owner/);
});

test("ingest fails closed on signature/assets/owner and suppresses duplicate message IDs", () => {
  const payload = { object: "whatsapp_business_account", entry: [{ id: "waba-1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "phone-1" }, messages: [{ id: "m-owner", from: "owner", type: "text", text: { body: "authorized" } }, { id: "m-stranger", from: "stranger", type: "text", text: { body: "PRIVATE STRANGER BODY" } }] } }] }] };
  const raw = Buffer.from(JSON.stringify(payload));
  const persisted = new Map<string, AcceptedWebhookEnvelope>();
  const acceptor = { accept(envelope: AcceptedWebhookEnvelope) { if (persisted.has(envelope.dedupeKey)) return false; persisted.set(envelope.dedupeKey, envelope); return true; } };
  const options = { signatureHeader: sign(raw), appSecret: "app-secret", expectedWabaId: "waba-1", expectedPhoneNumberId: "phone-1", allowedOwnerIds: ["owner"], acceptor };
  const accepted = ingestWebhook(raw, options);
  assert.deepEqual(accepted.map((message) => message.text), ["authorized"]);
  assert.doesNotMatch(JSON.stringify(accepted), /PRIVATE STRANGER BODY/);
  assert.deepEqual(ingestWebhook(raw, options), []);
  assert.deepEqual(ingestWebhook(raw, { ...options, signatureHeader: "sha256=" + "0".repeat(64) }), []);
  assert.deepEqual(ingestWebhook(raw, { ...options, expectedPhoneNumberId: "wrong", acceptor: { accept: () => true } }), []);
  assert.equal(persisted.size, 1, "duplicate acceptance is one atomic persistence decision");
});

test("relay uses lease and per-event ack protocol with authentication", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(input), init }); return calls.length === 1 ? Response.json({ protocolVersion: 1, events: [event] }) : new Response(null, { status: 204 }); }) as typeof fetch;
  const client = new WhatsAppRelayClient({ baseUrl: "https://relay.invalid", authToken: "token", ownerIds: ["owner"], expectedPhoneNumberId: "phone-1", fetchImpl });
  assert.deepEqual(await client.poll({ waitSeconds: 10, maxEvents: 2 }), [event]);
  await client.ack(event, "processed");
  assert.equal(calls[0].url, "https://relay.invalid/v1/inbox/lease");
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { protocolVersion: 1, waitSeconds: 10, maxEvents: 2 });
  assert.equal(new Headers(calls[0].init?.headers).get("henry-relay-version"), "1");
  assert.equal(calls[1].url, "https://relay.invalid/v1/inbox/evt_1/ack");
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { protocolVersion: 1, leaseToken: "lease_1", disposition: "processed" });
});

test("relay rejects insecure URLs and malformed closed responses", async () => {
  const unused = (async () => { throw new Error("unused"); }) as typeof fetch;
  assert.throws(() => new WhatsAppRelayClient({ baseUrl: "http://relay.invalid", authToken: "x", ownerIds: ["owner"], expectedPhoneNumberId: "phone-1", fetchImpl: unused }), /HTTPS/);
  assert.doesNotThrow(() => new WhatsAppRelayClient({ baseUrl: "http://localhost", authToken: "x", ownerIds: ["owner"], expectedPhoneNumberId: "phone-1", fetchImpl: unused, allowInsecureForTests: true }));
  for (const body of [{ protocolVersion: 2, events: [] }, { protocolVersion: 1, events: [{ ...event, leaseToken: "" }] }, { protocolVersion: 1, events: [{ ...event, surprise: true }] }, { protocolVersion: 1, events: [], extra: true }]) {
    const fetchImpl = (async () => Response.json(body)) as typeof fetch;
    await assert.rejects(new WhatsAppRelayClient({ baseUrl: "https://relay.invalid", authToken: "x", ownerIds: ["owner"], expectedPhoneNumberId: "phone-1", fetchImpl }).poll(), /invalid protocol/);
  }
});

test("outbox sends only a closed approved owner text execution and validates response", async () => {
  let captured!: { url: string; init?: RequestInit };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => { captured = { url: String(input), init }; return Response.json({ protocolVersion: 1, executionKey: "exec-1", state: "submitted", metaMessageId: "wamid.out" }); }) as typeof fetch;
  const client = new WhatsAppRelayClient({ baseUrl: "https://relay.invalid", authToken: "x", ownerIds: ["owner"], expectedPhoneNumberId: "phone-1", fetchImpl });
  const execution = { approvalId: "approval-1", executionKey: "exec-1", recipientId: "owner", replyToMessageId: "wamid.in", body: "Exact approved body", lastInboundAt: "2030-01-01T00:00:00.000Z", checkedAt: "2030-01-01T00:01:00.000Z" };
  assert.deepEqual(await client.sendApprovedText(execution), { protocolVersion: 1, executionKey: "exec-1", state: "submitted", metaMessageId: "wamid.out" });
  assert.equal(captured.url, "https://relay.invalid/v1/outbox");
  assert.deepEqual(JSON.parse(String(captured.init?.body)), { protocolVersion: 1, executionKey: "exec-1", approvalId: "approval-1", recipientId: "owner", replyToMessageId: "wamid.in", message: { type: "text", text: "Exact approved body" }, window: { lastInboundAt: execution.lastInboundAt, checkedAt: execution.checkedAt } });
  await assert.rejects(client.sendApprovedText({ ...execution, recipientId: "stranger" }), /not an allowed owner/);
  const malformed = (async () => Response.json({ protocolVersion: 1, executionKey: "exec-1", state: "submitted", secret: "leak" })) as typeof fetch;
  await assert.rejects(new WhatsAppRelayClient({ baseUrl: "https://relay.invalid", authToken: "x", ownerIds: ["owner"], expectedPhoneNumberId: "phone-1", fetchImpl: malformed }).sendApprovedText(execution), /invalid protocol/);
});

test("relay poll rejects foreign owners and wrong phone-number assets", async () => {
  for (const badEvent of [{ ...event, senderId: "stranger" }, { ...event, phoneNumberId: "phone-2" }]) {
    const fetchImpl = (async () => Response.json({ protocolVersion: 1, events: [badEvent] })) as typeof fetch;
    const client = new WhatsAppRelayClient({ baseUrl: "https://relay.invalid", authToken: "x", ownerIds: ["owner"], expectedPhoneNumberId: "phone-1", fetchImpl });
    await assert.rejects(client.poll(), /unauthorized inbox event/);
  }
});

test("webhook ingest enforces raw, entry, change, message, and text bounds", () => {
  const base = { object: "whatsapp_business_account", entry: [{ id: "waba-1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "phone-1" }, messages: [{ id: "m1", from: "owner", type: "text", text: { body: "ok" } }] } }] }] };
  const accepted: AcceptedWebhookEnvelope[] = [];
  const run = (payload: unknown, limits: Partial<typeof DEFAULT_WEBHOOK_LIMITS>) => {
    const raw = Buffer.from(JSON.stringify(payload));
    return ingestWebhook(raw, { signatureHeader: sign(raw), appSecret: "app-secret", expectedWabaId: "waba-1", expectedPhoneNumberId: "phone-1", allowedOwnerIds: ["owner"], acceptor: { accept: (envelope) => { accepted.push(envelope); return true; } }, limits });
  };
  assert.deepEqual(run(base, { maxRawBytes: Buffer.byteLength(JSON.stringify(base)) - 1 }), []);
  assert.deepEqual(run({ ...base, entry: [...base.entry, ...base.entry] }, { maxEntries: 1 }), []);
  assert.deepEqual(run({ ...base, entry: [{ ...base.entry[0], changes: [...base.entry[0].changes, ...base.entry[0].changes] }] }, { maxChangesPerEntry: 1 }), []);
  const twoMessages = { ...base, entry: [{ ...base.entry[0], changes: [{ ...base.entry[0].changes[0], value: { ...base.entry[0].changes[0].value, messages: [...base.entry[0].changes[0].value.messages, ...base.entry[0].changes[0].value.messages] } }] }] };
  assert.deepEqual(run(twoMessages, { maxMessagesPerChange: 1 }), []);
  assert.deepEqual(run(base, { maxTextChars: 1 }), []);
  assert.equal(accepted.length, 0, "bounded failures never reach durable acceptance");
});
