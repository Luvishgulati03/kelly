# WhatsApp relay protocol

Status: **foundation present; relay not deployed or live**. Henry's shared
runtime, approval, activity, and loopback-dashboard foundations exist, but the
WhatsApp runtime wiring and this relay protocol are not implemented. No
compatible relay deployment or live WhatsApp bridge is claimed.

## 1. Trust boundaries

The relay has one public Meta-facing route and a small authenticated API used by
Henry's local poller. It is a queue and policy boundary, not a proxy to arbitrary
Graph API paths.

- Meta-facing: `GET|POST /webhooks/meta/whatsapp`
- Henry-facing: `POST /v1/inbox/lease`, `POST /v1/inbox/{eventId}/ack`, and
  `POST /v1/outbox`
- Optional read-only reconciliation: `GET /v1/outbox/{executionKey}`

All Henry-facing calls require TLS and relay authentication. Requests are
bounded in size, use `Content-Type: application/json`, and carry a protocol
version such as `Henry-Relay-Version: 1`. The relay returns opaque public IDs;
it never returns its secrets or Meta access token.

## 2. Meta-facing behavior

`GET /webhooks/meta/whatsapp` implements Meta's verification challenge.
`POST /webhooks/meta/whatsapp` verifies `X-Hub-Signature-256` against the exact
raw body before parsing. Invalid requests receive a non-success response and are
not queued.

For a valid POST, the relay expands the batch into individual events, validates
the configured WABA and phone-number ID, applies item-level idempotency, and
persists accepted items before acknowledging the request. Unsupported but valid
events are acknowledged and counted without being sent to Henry. The webhook
handler never waits for a model or outbound send.

## 3. Inbox lease

Henry long-polls `POST /v1/inbox/lease` with a bounded wait and batch size. A
lease prevents concurrent local processes from processing the same event and
expires after a short server-controlled interval.

Example response (placeholder data):

```json
{
  "protocolVersion": 1,
  "events": [
    {
      "eventId": "evt_example",
      "leaseToken": "<opaque-single-use-lease>",
      "kind": "message.received",
      "metaMessageId": "wamid.example",
      "phoneNumberId": "<configured-phone-number-id>",
      "senderId": "<configured-owner-wa-id>",
      "receivedAt": "2030-01-01T00:00:00.000Z",
      "message": { "type": "text", "text": "Example inbound text" }
    }
  ]
}
```

The phase-one relay returns only allowlisted-owner messages. Henry acknowledges
each event separately with `POST /v1/inbox/{eventId}/ack`; the JSON body carries
that event's `leaseToken` and a terminal local disposition (`processed`,
`unsupported`, or `rejected`). There is no batch-ack endpoint. An expired or
already-used lease cannot acknowledge a different delivery. Redelivery after
lease expiry is expected; Henry's durable Meta-message-ID dedupe remains the
final defense against duplicate agent runs.

## 4. Outbox execution

`POST /v1/outbox` accepts only the configured owner recipient and one of two
closed message shapes:

```json
{
  "protocolVersion": 1,
  "executionKey": "<approval-id-and-payload-hash-derived-key>",
  "approvalId": "<local-approval-id>",
  "recipientId": "<configured-owner-wa-id>",
  "replyToMessageId": "wamid.example",
  "message": { "type": "text", "text": "Exact approved reply" },
  "window": {
    "lastInboundAt": "2030-01-01T00:00:00.000Z",
    "checkedAt": "2030-01-01T00:01:00.000Z"
  }
}
```

```json
{
  "protocolVersion": 1,
  "executionKey": "<approval-id-and-payload-hash-derived-key>",
  "approvalId": "<local-approval-id>",
  "recipientId": "<configured-owner-wa-id>",
  "message": {
    "type": "template",
    "name": "<approved-template-name>",
    "language": "<approved-language-code>",
    "components": []
  }
}
```

The relay validates the closed schema, destination, body/parameter limits,
reply context, and service-window/template policy. It does not accept raw Graph
API paths, caller-provided access tokens, arbitrary recipients, or a generic
JSON payload. Only the relay holds the Meta access token and invokes the Graph
API; the local Henry runtime never calls Meta directly.

The first request for an `executionKey` creates one durable outbox row. Reusing
the key with different bytes is a conflict. Reusing it with identical bytes
returns the stored state/result and never makes another Meta send call. The
relay stores the Meta message ID when available and updates the row from status
webhooks.

Suggested states are `accepted`, `submitted`, `sent`, `delivered`, `read`, and
`failed`. `submitted` means Meta accepted the API request; it does not mean the
recipient received the message. A transport timeout with an unknown Meta result
is `uncertain`, not permission to create a new execution key.

## 5. Errors, retention, and observability

Use stable machine-readable error codes, including `unauthorized`,
`invalid_signature`, `invalid_payload`, `owner_mismatch`, `duplicate`,
`idempotency_conflict`, `window_closed`, `template_required`,
`template_invalid`, `rate_limited`, and `upstream_uncertain`. Do not include
secrets, full identifiers, or message bodies in error text.

Correlate records with relay event ID, execution key, local approval ID, and
Meta message ID. Structured logs contain hashes or masked identifiers only.
Bound inbox/outbox retention, make deletion behavior explicit, and retain the
minimum audit metadata needed to prove deduplication and approval binding.

The relay exposes health and aggregate metrics through an authenticated
operator path, not through Henry's public webhook and not by exposing Henry's
dashboard. The dashboard itself remains loopback-only.
