# Module: design gallery

**You are Claude Code, Codex, or another coding agent, reading this inside
Kelly's repo.** Already implemented — don't rebuild it. Configure and verify
only.

## 1. What it does

A customer-facing design gallery for the boutique trade pack. The owner adds
photos of suits, sarees, lehengas and the rest; a customer at the counter
asks "show me trending lehengas" and Kelly shows a swipeable grid of photos
on the tablet, and can send the same photos as a Telegram album to the
owner's chat.

Only meaningful when the active trade pack declares `galleryCategories`
(boutique). Electrical's pack ships empty `galleryCategories`/`galleryTags`
lists, so `runtime.designs` still exists (nothing crashes) but every add is
rejected and the Designs pane and gallery prompt block never appear.

## 2. Store (`src/designs/store.ts`)

`DesignStore` keeps a SQLite index at `data/designs.db` and the image bytes
at `data/designs/<id>.<ext>` (id = `dsg_` + 16 hex). Constructed with the
active trade pack's `galleryCategories`/`galleryTags`, which are the only
valid values `add`/`update` accept — an unknown category or tag is rejected
with an error naming the valid list.

- `add({bytes, category, tags?, colours?, fabric?, occasion?, priceBand?, caption?})`
  — validates category/tags, rejects non-images by magic bytes (reuses
  `sniffImageMime` from `src/dashboard/attachments.ts`) and anything over
  8 MB, and deduplicates by sha256 (returns the existing record with
  `duplicate: true` rather than erroring).
- `get(id)`, `update(id, patch)`, `hide(id)` (soft delete — `status: 'hidden'`,
  the row and file stay on disk).
- `list(filter)` — `category`, `tags` (AND match), `text` (LIKE over caption/
  colours/fabric/occasion), `latest` (added within 30 days), `trending`
  (tagged `"trending"` OR `shown_count > 0`, unioned, ordered by
  `shown_count DESC, added_at DESC`), `limit`/`offset`.
- `markShown(ids)` — increments `shown_count` for every id actually shown to
  a customer (called from the SSE designs event and the Telegram album send).
- `stats()` — counts per category and per tag, plus `total`/`hidden`.

## 3. Semantic fallback (`src/designs/rag.ts`)

`DesignRag` mirrors `src/commerce/rag.ts`: caption, category, tags, colours,
fabric and occasion are indexed into a `KnowledgeBase` at
`data/designs-rag.db`. `DesignService.find(query, filter)` always tries SQL
(`DesignStore.list`) first; the semantic lane only fills in when SQL returns
fewer than 3 results **and** the query carries free text worth embedding.
`DesignService` owns both the store and the optional RAG and is what
`runtime.designs` returns.

## 4. CLI (`src/designs/commands.ts`, wired in `src/cli.ts`)

```bash
kelly designs add <file|folder> --category saree [--tags trending,bridal] \
  [--caption "..."] [--colours red,gold] [--fabric silk] [--occasion wedding] \
  [--price-band 5000-8000]
kelly designs list [--category] [--tags] [--latest] [--trending] [--json]
kelly designs search "<text>" [--category] [--limit 8] --json
kelly designs hide <id>
kelly designs tag <id> --add x --remove y
kelly designs stats
```

A folder target adds every `.png`/`.jpg`/`.jpeg`/`.webp` file directly inside
it (non-recursive). `kelly designs search ... --json` is what Kelly calls
mid-conversation; its output shape is:

```json
{ "designs": [{ "id": "...", "category": "...", "tags": [...], "caption": "...",
  "colours": [...], "fabric": "...", "occasion": "...", "priceBand": "...",
  "url": "/api/designs/<id>/image" }] }
```

## 5. HTTP routes (`src/dashboard/server.ts`)

| Route | Method | Role | Notes |
|---|---|---|---|
| `/api/designs` | GET | admin, counter | `?category=&tags=&text=&latest=1&trending=1&limit=` |
| `/api/designs/:id/image` | GET | admin, counter | image bytes, `cache-control: private, max-age=3600`, `content-security-policy: default-src 'none'; sandbox` |
| `/api/designs/:id/thumb` | GET | admin, counter | same bytes today (no resize dependency available); kept as its own route so the client never has to change when a real thumbnail lands |
| `/api/designs` | POST | admin only | raw image body; fields ride headers (below) |
| `/api/designs/:id` | PATCH | admin only | JSON patch: category/tags/colours/fabric/occasion/priceBand/caption |
| `/api/designs/:id` | DELETE | admin only | hides (never deletes the file) |
| `/api/designs/stats` | GET | admin only | `DesignStore.stats()` |

The counter role can only GET; every write method 403s for it (checked
explicitly in the role gate, not just by route prefix). POST headers:
`x-kelly-design-category`, `x-kelly-design-tags` (comma-separated),
`x-kelly-design-caption`, `x-kelly-design-colours`, `x-kelly-design-fabric`,
`x-kelly-design-occasion`, `x-kelly-design-price-band` — each
`decodeURIComponent`'d server-side (the switchboard's uploader
`encodeURIComponent`s them, so non-ASCII captions survive as HTTP headers).

## 6. The `designs` block contract

A model reply shows a gallery by ending with either a fenced block:

```` ```designs
["dsg_aaaa1111bbbb2222", "dsg_cccc3333dddd4444"]
```` 

(or `{"ids": [...]}`), or a line matching `DESIGNS: id, id, id`. Parsed by
`src/designs/block.ts` (`parseDesignsBlock`), shared by the dashboard SSE
loop and the Telegram bridge so both surfaces speak one grammar. Ids that
don't resolve to an active design are silently dropped; up to 8 ids are kept
per block.

The prompt line that tells Kelly how to use it lives in
`src/agent/henry.ts`, right after the trade pack's `promptBlock`, gated on
`galleryCategories.length`: run `kelly designs search "<what the customer
asked>" --category <one of the pack's categories> --json`, end the reply
with the fenced block containing only ids the search actually returned (max
8), and say in one sentence what's being shown — or say plainly that nothing
matched and name the nearest category.

In `src/dashboard/server.ts`'s `/api/chat/send` SSE loop, once the final
reply is in hand: the block is parsed and stripped from the text that goes
to chat history and the transcript, the matching designs are resolved and
`markShown`, and (if any resolved) an SSE `designs` event carries
`{designs:[{id,category,tags,caption,url,thumb}]}` — emitted **before**
`done`. The stored chat message also carries a `designs` field
(`id,category,tags,caption`) so history reloads still show the gallery
(`ConversationStore`'s `ChatMessage.designs`, `src/dashboard/conversations.ts`).

## 6a. Gallery fast path (`src/designs/fastpath.ts`)

A plain gallery-browse ask ("show me trending sarees", "dikhao lehenga
designs") has a complete, unambiguous answer in the local design store, so
it never has to go to the configured model — same reflex-lane precedent as
`src/reflex.ts` (narrow vocabulary, unambiguous answers only), just scoped
to trade packs that carry a gallery.

`galleryFastPath(prompt, pack, service)` returns `undefined` unless:

- `pack.galleryCategories.length` is non-zero (electrical never matches),
- the prompt is under 120 characters and contains a browse verb (`show`,
  `see`, `dikhao`, `dikha`, `view`, `display`, `latest`, `trending`,
  `designs`, `collection`, `options`),
- it names a known category (singular or plural), a known tag, or the
  literal word `latest`/`trending`/`designs`, and
- it carries none of the pricing/quantity/judgment words (`price`, `rate`,
  `cost`, `how much`, `kitna`, `quote`, `quotation`, `stitch`,
  `measurement`, `order`, `book`, `cheaper`, `compare`, `which one`,
  `suggest`, `recommend`, or a digit run followed by a unit like `2
  metres`) — any of those routes straight to the model instead.

When it matches: it runs `service.find(prompt, {limit: 8})` (the same query
parser `DesignService.find` already uses for tags/categories/latest/
trending), `markShown`s whatever it resolves, and returns one plain
sentence for both `text` and `spoken` — "Showing 4 trending saree
designs.", or, when a trending category comes up empty, "No saree designs
match trending yet; here are the latest sarees." (widened to that
category's latest), or "No designs in the gallery for that yet." when
nothing at all is found.

In `/api/chat/send`, right after the reflex check, `runtime.trade
.galleryCategories.length` gates a call to `galleryFastPath`; a match
records the turn in the conversation exactly like a normal reply (with the
`designs` field), streams `token` then `designs` then `done` with
`{response, spoken, provider: "fastpath", durationMs, conversationId}`,
logs a `run.completed` activity event with `{provider: "fastpath",
durationMs}`, and returns without calling the provider — voice turns
(`voice: true`) go through the same path. Anything the fast path doesn't
match falls through to the normal model turn unchanged.

## 7. Counter tablet (`src/dashboard/voice.html`)

The `designs` SSE event (and a stored message's `designs` field, on history
load) renders a horizontal snap-scrolling strip (`.gallery`,
`scroll-snap-type: x mandatory`, cards 220px on desktop / 78vw on phones)
inside Kelly's chat bubble: each card is a 4:5 `object-fit: cover` image
with a category chip and caption, lazy-loaded. Tapping a card opens a
full-screen `<dialog id="lightbox">` showing the same set — arrow keys,
swipe, and a close button/`Escape` move between or leave it. Images load
through `/api/designs/:id/thumb` in the strip and `/api/designs/:id/image`
in the lightbox.

## 8. Switchboard pane (`src/dashboard/page.ts`)

A "Designs" tab (`#tab-designs`), shown only when `/api/status`'s
`trade.galleryCategories` is non-empty: a per-category stats row, a filter
bar (auto-built category chips plus Latest/Trending toggles and a text
search), a responsive thumbnail grid with a Hide button per card, and an
"Add designs" drop zone / file picker (admin only) that POSTs each file with
the category and tags chosen in the bar.

## 9. Telegram album (`src/telegram/media.ts`, `src/telegram/bridge.ts`)

When an owner-chat reply from the bridge carries a `designs` block, the
block is parsed and stripped from the Telegram text the same way as the
dashboard, then — best effort, after the text send, never failing the turn
— `sendTelegramPhotoAlbum` sends the resolved images as one `sendMediaGroup`
call (up to 10 photos; Telegram's own per-call cap) with the first photo's
caption set to that design's caption. No dependency: the multipart body is
built with Node's built-in `FormData`/`Blob`, the same mechanism
`sendTelegramVoiceNote` already uses. `TelegramBridge` never imports the
sender itself (doctrine rule 7 — see `src/telegram/bridge.ts`'s header
comment); `runtime.ts` injects `photos: (ids) => this.sendDesignAlbum(ids)`
only when the active trade has gallery categories and a bot token + chat id
are configured.

## 10. Demo seed (`src/designs/seed.ts`, `src/designs/png.ts`)

`kelly start --demo --trade boutique` seeds 14 placeholder designs (two per
gallery category, mixed tags) the first time the demo's `designs.db` is
empty, so the gallery is testable immediately without real photos. Images
are plain two-tone colour blocks encoded by a minimal hand-rolled PNG
encoder (`src/designs/png.ts`, built on Node's own `zlib.deflateSync` — no
image dependency). Seeding is idempotent: it only runs when
`DesignStore.stats().total === 0`.

## 10a. Misheard words (`src/designs/vocabulary.ts`)

whisper.cpp mis-hears garment words with no prompt context: a real boutique
demo had the owner say "lehenga" and got back "Lengar", then "lehinga". The
old fast path fired on the bare word "designs" with no recognised category,
`DesignService.find` narrowed nothing, and the unfiltered store (every
category) came back — 8 random designs shown twice. Three pieces close
that gap:

- **Vocabulary prompt.** `TradePack.vocabulary: string[]` (boutique:
  garment names, work types, fabrics; electrical: brands, units) is turned
  into `"<shop name>: word, word, ..."` by `voicePrompt(shopName,
  vocabulary)` and passed as `TranscriptionOptions.prompt` to
  `LocalVoiceService.transcribe`, which forwards it to whisper-cli as
  `--prompt <text>` (capped at 400 chars, newlines and quotes stripped, and
  omitted entirely when there is no vocabulary or the prompt is blank).
  Both voice surfaces set it: the dashboard's `/api/voice/transcribe`
  route (`src/dashboard/server.ts`) and the Telegram voice intake
  (`src/runtime.ts`'s `buildTelegramVoiceIntake`, threaded through
  `VoiceIntakeLimits.prompt` in `src/telegram/voice.ts`). This primes
  whisper toward the shop's own words but never guarantees a correct
  transcript — the next two pieces are what actually recover from a miss.

- **Aliases and fuzzy matching.** `TradePack.aliases: Record<string,
  string[]>` maps every gallery category, every gallery tag, and the two
  query intents `latest`/`trending` to known spoken/misspelled/Devanagari
  variants (e.g. `lehenga: [lehnga, lehinga, lengha, langa, ..., लहंगा,
  ...]`). `resolveTerm(token, pack)` in `src/designs/vocabulary.ts` checks,
  in order: the literal `latest`/`trending` words (always intent, even
  though the pack also uses them as literal tag names), exact category/tag
  names (singular or plural), the alias table (any script), and finally —
  only for Latin tokens of 4+ letters, and against category/tag names and
  the pack's own Latin aliases — a restricted Damerau-Levenshtein fuzzy
  match: distance ≤ 1 for 4-5 letter tokens, ≤ 2 for 6+ letter tokens.
  3-letter (or shorter) tokens are never fuzzed. `tokenize(text)` reads
  both Latin and Devanagari words out of one prompt, so "लहंगा dikhao"
  resolves the same as "show me lehenga". This is strong enough to recover
  the incident outright: "lehinga" matches the literal alias, and "Lengar"
  (whisper's actual mis-transcription) is distance 2 from the "langa"/
  "lengha" aliases, within the 6-letter budget — both now resolve straight
  to the `lehenga` category instead of falling through to an unfiltered
  set. `DesignService.parseQuery` (`src/designs/rag.ts`) and
  `galleryFastPath` (`src/designs/fastpath.ts`) both parse a query through
  `tokenize`/`resolveTerm` now, replacing their earlier ad hoc exact-word
  matching.

- **Clarify instead of guessing wrong.** `galleryFastPath` only proceeds
  when it recognises a category, a tag, or a `latest`/`trending` intent.
  When the prompt is an explicit browse ask (a browse verb plus
  `designs`/`collection`/`options`) but nothing else was recognised — the
  literal shape of "show me designs" or an unrecognised noun immediately
  before "designs" that the fuzzy rule still can't place, e.g. "show me
  gumboot designs" — it returns a clarification instead of the model or an
  unfiltered gallery: `{text, spoken: "Which designs would you like to
  see: suits, sarees, lehengas, blouses, kurtis, gowns or dupattas?",
  designs: [], clarify: true}`, built from the pack's own category list.
  The dashboard SSE loop (`src/dashboard/server.ts`) streams it exactly
  like any other fast-path answer (`token`, `designs` with an empty array,
  `done` with `provider: "fastpath"`) — no gallery, no model call.
  `latest`/`trending` alone (no category) is never treated as ambiguous —
  "latest designs" answers directly and may legitimately mix categories,
  saying so in the sentence ("Showing the 8 latest designs across
  categories."). The model path carries the same instruction: the DESIGN
  GALLERY prompt block in `src/agent/henry.ts` tells Kelly to ask which
  category rather than show a mixed set when a word isn't understood.

## 11. Limits

- 8 MB per image, PNG/JPEG/WebP/GIF only (magic-byte sniffed).
- Categories and tags are validated against the active trade pack; there is
  no way to add a design in a category the pack doesn't declare.
- A `designs` block is capped at 8 ids; `sendTelegramPhotoAlbum` is capped
  at 10 (Telegram's own `sendMediaGroup` limit).
- `/api/designs/:id/thumb` currently serves the original bytes — no resize
  dependency (e.g. `sharp`) is installed, and none was added for this.
