# Module: boutique rate card, quoting, and spoken replies

**You are Claude Code, Codex, or another coding agent, reading this inside
Kelly's repo.** Already implemented — don't rebuild it. Configure and verify
only.

## 1. What it does

The boutique trade pack (`src/trade/boutique.ts`, `brandRequired: false`)
turns a ladies' boutique's stitching price list into a rate card Kelly can
quote from, and makes sure every spoken reply (dashboard voice and Telegram
voice) names a price that was calculated the same way, never one the model
wrote in prose.

## 2. Rate card import

Rate-card rows are ordinary catalogue rows (`src/commerce/workbooks.ts`,
`extractCatalogueRows`); the boutique pack does not need a separate importer.
Two relaxations make a boutique sheet importable:

- **Brand is optional.** A sheet with no brand column imports fine; every row's
  brand becomes the shop name (`config.shopName`) passed to
  `extractCatalogueRows`, or `"house"` if unset. `CommerceService.createQuote`
  defaults a missing `request.brand` the same way, unless the active pack has
  `brandRequired: true` (electrical), in which case a brand is still required.
- **A code/SKU column is optional.** A sheet with no code column gets one
  derived from category and name — uppercase, hyphenated, deduplicated with a
  `-2`, `-3`, ... suffix — recorded in `sourceLocation` so it's traceable back
  to "derived, not printed on the sheet."

Header matching also accepts common boutique spellings: `item`/`service`/
`garment`/`description` for the item name, `category`/`garment`/`type` for
category, `unit`/`per`/`basis` for unit, `rate`/`charge`/`price`/`stitching`
for price, `code`/`sku`/`itemcode` for the identifier.

## 3. Starter template

`kelly catalogue template [--out file]` (`src/commerce/template.ts`) writes
the active trade pack's example workbook: `data/templates/boutique-ratecard.xlsx`
for boutique (14 example rows — suit plain/lining/embroidery, blouse plain/
padded, lehenga cancan, saree fall-and-pico, kurti, gown, dupatta edge, an
urgent-delivery surcharge, two fabric-supply rows, and an alteration row, all
at 5% GST) or `data/templates/electrical-catalogue.xlsx` for electrical.

## 4. Demo seed

`kelly start --demo --trade boutique` seeds `data/demo-boutique/data` with the
boutique template, imported and published, the first time the demo catalogue
is empty (`src/commerce/demo-seed.ts`, called from `bin/start.mjs`). It is
idempotent: importing the same template twice is detected as a duplicate by
content hash and only published once. This never touches an owner's real
`KELLY_DATA_DIR`.

## 5. Quoting without a brand

`CommerceService.createQuote` (`src/commerce/service.ts`) no longer requires
`request.brand`. When the active trade pack sets `brandRequired: false` and no
brand is supplied, it defaults to the shop name (or `"house"`), which matches
what `extractCatalogueRows` wrote onto every imported row, so the store search
still resolves. Electrical (`brandRequired: true`) still throws `A brand is
required` when one is missing.

## 6. Spoken replies

`src/voice/speakable.ts` turns a chat reply into one or two short, TTS-safe
English sentences:

- `speakableSummary({ reply, quote, shopName, maxChars })` prefers a fenced
  ` ```spoken ` block (the voiceMode prompt in `src/dashboard/server.ts` asks
  the model to end a voice turn's answer with one); otherwise it falls back to
  the reply's first plain paragraph.
- `stripForSpeech` strips markdown (fences, headings, emphasis, links,
  tables) and rewrites `₹`/`Rs.` amounts as "<amount> rupees".
- When a `CalculatedQuote` is supplied, the price sentence is always built in
  code from `quote.totalPaise` (`formatRupeesForSpeech`, Indian digit
  grouping, e.g. "6,053 rupees and 40 paise") — it replaces or appends to
  whatever the prose said, so the spoken price always equals the exportable
  document. An incomplete quote says "The quotation still has an unresolved
  line." instead of a price.
- `stripSpokenBlock` removes the fence for display; the dashboard's
  `/api/chat/send` route stores and returns this stripped text and sends the
  spoken summary separately as `spoken` in the `done` SSE payload.
- `extractQuoteIdFromReply` is a best-effort parse of `quote id <uuid>` or a
  `"id": "<uuid>"` field from the reply text, since there is no structured
  tool-result hook between the CLI and the chat route yet; documented as a
  known limitation in the code.

Telegram voice replies go through the same `speakableSummary` (never the full
chat answer) via `TelegramBridge.speakAnswer` (`src/telegram/bridge.ts`), and
`telegramVoiceReplier` (`src/telegram/voice.ts`) pins the synthesis language to
`"en"` — spoken summaries are always English prose. Kokoro's own language
mapping (`synthesizeWithKokoro` in `src/voice/index.ts`) still only picks
`"hi"` when the caller explicitly asks for it or the text itself contains
Devanagari; Roman-script text never goes to `"hi"`.
