# Module: WhatsApp Cloud API bridge

Status: **foundation present; bridge not implemented or live**. Henry's shared
runtime, approval store, activity log, and loopback dashboard modules exist, but
the WhatsApp runtime wiring described here does not. No relay is deployed, and
no live WhatsApp bridge, Meta app, phone number, or webhook setup is claimed to
work. Completing the steps below is not evidence of a verified deployment.

## 1. Scope and safety contract

This module connects Henry to the official Meta WhatsApp Cloud API through a
small, dedicated HTTPS relay. It does not use WhatsApp Web, a consumer session,
or an unofficial client library.

Phase one is deliberately narrow:

- Only messages whose WhatsApp sender ID exactly matches the configured owner
  allowlist may enter Henry. All other inbound messages are acknowledged and
  discarded at the relay, before their content reaches the local agent.
- An owner message is an instruction to Henry, not authorization to send a
  WhatsApp message. Every outbound reply is first stored as a pending approval.
- Approval binds the exact recipient, reply context, message type, and rendered
  body (or template name, language, and parameters). Editing any bound field
  invalidates the approval and creates a new pending item.
- Approval and execution are separate transitions. The executor must atomically
  claim an already-approved item before calling the relay. A conversational
  “yes,” a scheduled task, or receipt of a new inbound message cannot approve it.
- Phase one supports exact replies to the owner only. It is not a general
  contact-messaging, group, broadcast, campaign, or customer-support surface.

The proposed approval kind is `whatsapp.send`. Adding it requires a code change
to the shared approval type, runtime executor, activity types, and tests; those
changes are outside this document and have not been made.

## 2. Architecture

```text
Inbound:
Meta WhatsApp Cloud API
  -- public HTTPS webhook --> dedicated relay
  <-- GET challenge / POST acknowledgement --

dedicated relay
  -- authenticated POST /v1/inbox/lease response --> local Henry runtime
  <-- authenticated POST /v1/inbox/{eventId}/ack --

Outbound:
local Henry runtime
  -- authenticated POST /v1/outbox --> dedicated relay
  -- no direct Meta credentials or Graph API calls

dedicated relay
  -- Graph API /<PHONE_NUMBER_ID>/messages --> Meta WhatsApp Cloud API
  <-- API response and later status webhooks --
```

The local runtime owns the normal agent/session, pending approval creation,
atomic approved-item claim, and loopback-only dashboard. The relay owns the GET
verification handshake, POST raw-body signature verification, owner allowlist,
payload limits, durable inbox/outbox, deduplication, and every Meta Graph API
call. Henry has no direct local Graph client and does not hold the Meta access
token.

The relay is a separate, least-privilege service because Meta needs a stable,
public HTTPS webhook while Henry and its dashboard remain local. The relay must
not contain a model, memory store, general shell, dashboard, or approval UI. It
stores only bounded delivery records and forwards accepted envelopes to an
authenticated local poller. Henry never exposes a listener through a tunnel.

Use separate credentials for the two trust boundaries:

- Meta authenticates webhook POSTs with the app-secret signature.
- Henry authenticates to the relay with a relay credential. Prefer short-lived,
  audience-bound credentials; if a static token is used initially, scope it to
  one deployment and rotate it independently of Meta credentials.

See [the relay protocol](../whatsapp-relay-protocol.md) for the endpoint and
delivery contract.

## 3. Meta assets and configuration

Create or select these assets in Meta's developer and business tooling:

1. A Meta developer app with the WhatsApp product.
2. A WhatsApp Business Account (WABA).
3. A Cloud API business phone number and its phone-number ID.
4. A system user or other production-appropriate access token with only the
   permissions required by the chosen Meta setup. Do not document or commit the
   token value.
5. A webhook subscription for the WABA `messages` field, pointed at the relay's
   public HTTPS callback.
6. Approved message templates for any outbound initiation or reply that may
   occur outside the customer-service window.

Use placeholders in `.env.example` and secret storage; never put real IDs,
phone numbers, tokens, app secrets, or verify tokens in documentation:

```dotenv
# Local Henry process
HENRY_WHATSAPP_ENABLED=false
HENRY_WHATSAPP_RELAY_URL=https://relay.example.invalid
HENRY_WHATSAPP_RELAY_TOKEN=<relay-client-credential>
HENRY_WHATSAPP_OWNER_WA_ID=<digits-only-owner-whatsapp-id>

# Relay secret store (not the local dashboard environment)
META_WHATSAPP_APP_ID=<meta-app-id>
META_WHATSAPP_APP_SECRET=<meta-app-secret>
META_WHATSAPP_VERIFY_TOKEN=<random-webhook-verification-token>
META_WHATSAPP_WABA_ID=<whatsapp-business-account-id>
META_WHATSAPP_PHONE_NUMBER_ID=<cloud-api-phone-number-id>
META_WHATSAPP_ACCESS_TOKEN=<production-access-token>
META_GRAPH_API_VERSION=<supported-pinned-version>
WHATSAPP_RELAY_CLIENT_TOKEN=<relay-client-credential>
WHATSAPP_OWNER_WA_ID=<digits-only-owner-whatsapp-id>
```

Pin a supported Graph API version at deployment time rather than copying a
version from this guide. Confirm current permissions, token lifecycle, webhook
fields, template rules, and pricing in Meta's official documentation before
launch: [Cloud API overview](https://developers.facebook.com/docs/whatsapp/cloud-api/),
[webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/),
and [message templates](https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/).

## 4. Webhook authenticity and idempotency

For Meta's verification `GET`, require `hub.mode=subscribe` and a constant-time
match of `hub.verify_token` to `META_WHATSAPP_VERIFY_TOKEN`; return only the
provided `hub.challenge`. The verify token is a shared challenge secret, not an
API access token.

For every webhook `POST`:

1. Capture the exact raw request bytes before JSON parsing.
2. Require `X-Hub-Signature-256` in `sha256=<hex>` form.
3. Compute HMAC-SHA256 over the raw bytes with
   `META_WHATSAPP_APP_SECRET`, compare equal-length byte sequences in constant
   time, and reject invalid or missing signatures.
4. Enforce HTTPS, request-size and parse-depth limits, expected
   `object=whatsapp_business_account`, the configured WABA and phone-number ID,
   and supported event/message types.
5. Persist the accepted event before returning a success response. Queue local
   processing; do not run the model in the webhook request.

Meta can retry and webhook batches can contain multiple messages or statuses.
Deduplicate each item, not just each HTTP request. For inbound messages, use the
Meta message ID (`messages[].id`) as the stable key, namespaced by WABA and
phone-number ID. For status updates, include message ID, status, and status
timestamp in the key. A duplicate must return success without re-running Henry
or creating another approval.

Outbound execution needs a second idempotency boundary. Henry sends a stable
execution key derived from the approval ID plus a hash of all approved fields.
The relay stores the first terminal result and returns that same result for
retries. It must never issue a second Graph API call for the same key. Persist
Meta's returned message ID and reconcile later `sent`, `delivered`, `read`, and
`failed` webhook statuses; API acceptance alone is not proof of delivery.

## 5. Inbound and exact-reply flow

1. The relay authenticates, validates, item-deduplicates, and persists the Meta
   webhook.
2. It checks the inbound `wa_id`/sender identifier against the single configured
   owner ID. A non-match is recorded only as a redacted rejection metric and is
   not forwarded. Do not log message content or the full rejected identifier.
3. Henry's local poller requests a lease with `POST /v1/inbox/lease`, records
   the Meta message ID, and processes the leased envelope through the normal
   agent/session path. It then acknowledges that individual event with
   `POST /v1/inbox/{eventId}/ack` and the event's single-use lease token.
4. Henry may produce a proposed reply, but stores it locally as a pending
   `whatsapp.send` approval. The payload includes the owner recipient ID, source
   message ID, exact reply body or exact template payload, content hash, and
   customer-service-window evidence.
5. The loopback dashboard displays the complete rendered payload. A human
   explicitly approves that exact item. Approval does not send it.
6. A separate execution action atomically claims the approved item and calls
   `POST /v1/outbox` on the authenticated relay with its idempotency key. The
   relay rechecks destination and message policy before it—not Henry—calls the
   Meta Graph API.
7. Henry records the Meta message ID and subsequent delivery status. Ambiguous
   timeouts remain `executing`/uncertain until reconciled; they are not blindly
   retried under a new key.

## 6. The 24-hour window and templates

A free-form reply is allowed only while Meta's customer-service window is open,
normally 24 hours from the user's most recent message. Outside that window,
send only a Meta-approved template in an approved language with parameters that
match the approved structure. Template approval is not approval in Henry: the
fully rendered recipient and parameters still require a pending approval item,
human approval, and a separate execution claim.

Store the last qualifying inbound timestamp as evidence, but treat local time
calculation as a preflight guard rather than authority. Recheck immediately
before execution, allow for clock skew and queue delay, and surface Meta's
response/status error. If the window may have closed, fail closed and stage an
appropriate template as a new approval; never silently transform an approved
free-form message into a template or alter approved text.

## 7. Dashboard and operations

WhatsApp activity, relay health, redacted inbound decisions, pending approvals,
execution attempts, Meta message IDs, and delivery states belong on the existing
dashboard. Keep it bound to `127.0.0.1` (normally
`http://127.0.0.1:7337`). Do not expose approval or execution controls through
the public relay. Any future remote dashboard mode must be explicitly enabled,
strongly authenticated, and must not expose a full-access provider or outbound
controls on an unauthenticated interface.

Logs and metrics must redact message bodies, tokens, app secrets, verify tokens,
and full phone/WhatsApp identifiers. Apply retention limits to relay payloads,
encrypt durable queues and backups where supported, restrict administrative
access, rotate secrets, and provide a kill switch that stops polling and sends
without disabling local Henry.

## 8. Deployment and test plan

Do not call the bridge live after deployment alone. Promote it in stages:

1. **Unit tests:** raw-byte HMAC verification (valid, invalid, malformed, and
   missing headers); GET challenge; owner filtering; batch parsing; size limits;
   item-level dedupe; exact approval hashing; atomic claims; relay outbound
   idempotency; 24-hour boundary and template validation; secret redaction.
2. **Contract tests:** replay sanitized Meta fixture batches containing inbound
   messages and status updates. Verify duplicate and out-of-order delivery,
   unsupported message types, expired leases, and crash recovery.
3. **Local integration:** run a fake Meta endpoint and fake relay. Assert an
   owner message creates one pending approval, another sender creates none,
   pending execution fails, approved-but-unclaimed execution fails, payload
   mutation fails, and one claimed item causes exactly one mock send.
4. **Staging:** deploy an isolated relay with test assets and a test recipient.
   Complete Meta's webhook challenge, send signed fixtures, then exercise a real
   inbound test only after confirming data handling and access controls. Test a
   free-form reply inside the window and an approved test template outside it.
5. **Failure drills:** duplicate webhooks, relay restart, local outage, Graph API
   timeout after acceptance, delayed/out-of-order statuses, token rotation,
   revoked token, closed window, template rejection, and kill-switch recovery.
6. **Production readiness review:** verify the current Meta terms and docs,
   least-privilege credentials, backups/retention, alerts, rate limits, cost
   controls, rollback, and dashboard loopback binding. Enable production only by
   an explicit operator decision.

A passing test suite demonstrates the implementation contract, not that Meta
assets are approved or that live delivery works. Record real webhook and message
IDs only in protected operational storage, never in public docs or fixtures.
