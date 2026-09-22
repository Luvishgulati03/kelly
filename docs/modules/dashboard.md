# The switchboard (Kelly's dashboard)

`kelly dashboard` serves one page at `http://127.0.0.1:7338` (loopback only). It is
scanned, not read: the summary is on top, and every number on it is measured rather
than decorated.

## Panes

The hash is the route, so `/#voice`, `/#logs` and `/#usage` reload and share.

- **Overview.** The heartbeat draws one spike per real activity event received over the
  live event stream; its number is the count of events in the last minute. A quiet
  stream turns the trace amber after 8 seconds and flat red after 20, so a dead
  process looks dead. Below it: the Codex cooldown state, today's runs and tokens,
  today's voice interactions, and a "needs you" list built from pending approvals,
  unconfirmed transcripts, failed runs and memory pressure.
- **Voice transcripts.** Everything Kelly heard, from the counter page and from
  Telegram voice notes, with what became of each transcript: `transcribed` (waiting
  for a typed yes), `confirmed`, `answered` (Kelly's reply is kept beside it),
  `dropped`, `expired`, or `failed` (no words kept, only the reason). Brands,
  quantities and units that survived transcription are shown as chips; a transcript
  with neither a brand nor a quantity is flagged so the owner can see Kelly should
  have asked. Retention settings live at the top of the pane.
- **Logs.** The activity journal, newest first, with Kelly's own filters (runs, voice,
  catalogue, quotations, approvals, Telegram, errors), a severity stripe per row, and
  the metadata on click. New events arrive live.
- **Usage and quota.** Codex is a subscription, so this is tokens and windows, not
  rupees: a seven-day stacked chart of the input, cached and output tokens each turn
  reported, turn latency (p50, p95, first text), whisper real-time factor, the
  cooldown ledger, and local RAM. A table view sits under the chart.
- **Catalogue.** Published-product search and the supplier files awaiting review.
  Chat, the counter voice page and the memory constellation keep their own pages.

## Retention

Set from the Voice pane and stored under `voice` in `data/settings.json`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `retentionDays` | 60 | Transcript text is deleted after this many days (1 to 365). |
| `recordAudio` | off | While off, no recording is ever written. Switching it off deletes every kept recording. |
| `audioRetentionDays` | 7 | Kept recordings are deleted after this many days (1 to 90), independently of the text. |

Transcripts live in `data/voice/transcripts.db`; recordings in `data/voice/audio/`.
Both are private to the owner (0600), never leave the machine, and are never committed.
The words themselves never enter the activity log; the log carries only sizes and timings.

## Counter mode (planned, built behind a flag)

`voice.counterMode` in `data/settings.json` is `"review"` (default) or `"conversation"`,
overridable per-process with `KELLY_COUNTER_MODE` (a valid value wins over whatever is
persisted; an invalid one is ignored). It is a toggle in the Voice pane's "Counter mode"
card (admin only), and read-only for every role at `GET /api/voice/status`'s `counterMode`
field so the counter tablet can act on it without admin rights.

- **review** (today's behaviour) — `/voice` serves the owner's review page: a transcript is
  shown and must be typed-confirmed before it reaches Kelly.
- **conversation** — a `counter`-role `GET /voice` 302s to `/counter` instead (admins can
  still open either page); `/counter` sends transcripts straight to Kelly with no review
  step and speaks replies back. See `docs/voice.md` for the counter page's speech-latency
  mechanics (early `spoken` SSE event, chunked TTS, Kokoro warm-up).

`/counter` itself is served in both modes (so it can be tested while still in "review"); the
page is expected to read its own mode off `GET /api/voice/status` and show a banner in
review mode.

## APIs

| Route | Purpose |
| --- | --- |
| `GET /api/voice/transcripts?surface=&state=&language=&q=&sparse=&limit=` | History with stats and settings. |
| `GET /api/voice/transcripts/:id` | One transcript, with `audio: true` when a recording is kept. |
| `GET /api/voice/audio/:id` | The kept recording, or 404. |
| `GET` / `POST /api/voice/settings` | Read or change retention and `counterMode` (admin only). |
| `GET /api/voice/status` | `{available, sttEnabled, ttsEnabled, counterMode}` — every role, no admin required. |
| `GET /voice` | Owner review page. Redirects a `counter`-role request to `/counter` when `counterMode` is `"conversation"`. |
| `GET /counter` | Customer-facing counter tablet page (design gallery, and the conversation-mode voice flow). |
| `GET /api/usage` | Seven-day usage summary from the activity journal and the cooldown ledger. |
| `GET /api/events` | Server-sent events: `activity`, `resources`, `agent`. |

All routes sit behind the dashboard's authentication like every other route.
