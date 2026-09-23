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

`voice.counterMode` in `data/settings.json` is `"review"` (default), `"conversation"`, or
`"talk"`, overridable per-process with `KELLY_COUNTER_MODE` (a valid value wins over whatever
is persisted; an invalid one is ignored). It is a toggle in the Voice pane's "Counter mode"
card (admin only), and read-only for every role at `GET /api/voice/status`'s `counterMode`
field so the counter tablet can act on it without admin rights.

- **review** (today's behaviour) — `/voice` serves the owner's review page: a transcript is
  shown and must be typed-confirmed before it reaches Kelly.
- **conversation** — a `counter`-role `GET /voice` 302s to `/counter` instead (admins can
  still open either page); `/counter` sends transcripts straight to Kelly with no review
  step and speaks replies back, but the customer still taps to talk. See `docs/voice.md` for
  the counter page's speech-latency mechanics (early `spoken` SSE event, chunked TTS, Kokoro
  warm-up).
- **talk** — Kelly Talk, the hands-free loop: no tap between turns. `/counter` serves
  `talk.html` instead of `counter.html`; a `counter`-role `GET /voice` 302s to `/counter`
  here too. The page greets the customer, listens, replies (typed and spoken), and listens
  again on its own. See "Kelly Talk" below.

`/counter` itself is served in every mode (so it can be tested without flipping the shop's
live setting): in `"review"` it serves `counter.html`, or `talk.html` when the request adds
`?page=talk`; in `"conversation"` it serves `counter.html`; in `"talk"` it serves
`talk.html`. `GET /talk` is a direct alias that always serves `talk.html` regardless of mode.
Each branded page reads its own mode off `GET /api/voice/status` and shows a banner in review
mode.

## Kelly Talk (`voice.counterMode: "talk"`)

The hands-free counter loop: `src/dashboard/talk.html`, served at `/talk` (and at `/counter`
when the mode is `"talk"`, or via `?page=talk` while previewing in `"review"`). One session
per tap of the orb: greet, listen, reply (spoken + typed captions behind `?captions=1`),
listen again — no further tap until the customer presses to end it.

- **Greeting / reprompt audio** — `GET /api/voice/greeting` and `GET /api/voice/reprompt`
  synthesise each trade's fixed phrase (`<shop>` substituted from `config.shopName`) **once
  per process** and cache the WAV bytes in memory and on disk under
  `<dataDir>/voice/cache/<sha256 of the text>.wav`, so a restart is instant. Both routes 404
  with a JSON body when TTS is disabled. Both are warmed best-effort at dashboard startup,
  immediately after the existing Kokoro "Ready." warm-up, logging `voice.tts.warm` with
  `{kind: "greeting" | "reprompt", ms}`.
- **Speech detection** — Silero VAD (`@ricky0123/vad-web` + `onnxruntime-web`, served from
  `/vendor/vad/*`, see below) when it loads, with the page's own energy-level VAD as the
  automatic fallback if the bundle 404s or `MicVAD` fails to initialise. Thresholds: 0.55
  speech-start / 0.35 speech-end (Silero), or a 0.12 RMS energy threshold with a 250 ms
  minimum speech run and a 700 ms (1400 ms after 4 s of talking) end-of-turn silence window
  for the energy fallback. A 25 s hard cap ends any one utterance; an 8 s silence after a
  reply re-prompts ("Still there?"); a further 15 s of silence ends the session with a chime.
  Playback and capture are half-duplex — a press on the orb while Kelly is speaking
  interrupts her and returns to listening immediately.
- **Vendor VAD assets** — `GET /vendor/vad/<name>` serves a fixed allowlist of basenames
  straight from `node_modules` (no copy into `src/`), `cache-control: public, max-age=86400`:
  - from `@ricky0123/vad-web/dist/`: `bundle.min.js`, `vad.worklet.bundle.min.js`,
    `silero_vad_v5.onnx`, `silero_vad_v6.onnx`, `silero_vad_legacy.onnx`
  - from `onnxruntime-web/dist/`: `ort-wasm-simd-threaded.mjs` / `.wasm`, and the
    `.asyncify` / `.jsep` / `.jspi` `.mjs` / `.wasm` variants
  Any other basename 404s — no path traversal, no arbitrary `node_modules` reads. GET is
  counter-role reachable (`/vendor/` prefix in `counterAllowedRoute`); other methods on the
  prefix still require admin.
- **Session telemetry** — `talk.html` posts `POST /api/voice/talk/session`
  `{event:"start"}` when a session opens and `{event:"end", turns, reason?}` when it closes
  (`reason` one of `"press"` | `"sleep"` | `"error"`), which land as `talk.session.started` /
  `talk.session.ended` activity events. `GET /api/usage`'s `talk: {sessions, turns}` and the
  switchboard's Usage pane ("talk sessions: N (M turns)") are rolled up from
  `talk.session.ended`.
- Still planned: a Silero-side hard cap (today's 25 s cap only fires inside the energy-VAD
  path), tuning the thresholds above against real shop-floor audio, and the quotation PDF
  (unrelated, tracked separately in `context.md`).

## APIs

| Route | Purpose |
| --- | --- |
| `GET /api/voice/transcripts?surface=&state=&language=&q=&sparse=&limit=` | History with stats and settings. |
| `GET /api/voice/transcripts/:id` | One transcript, with `audio: true` when a recording is kept. |
| `GET /api/voice/audio/:id` | The kept recording, or 404. |
| `GET` / `POST /api/voice/settings` | Read or change retention and `counterMode` (admin only). |
| `GET /api/voice/status` | `{available, sttEnabled, ttsEnabled, counterMode}` — every role, no admin required. |
| `GET /api/voice/greeting` / `GET /api/voice/reprompt` | Cached WAV of the trade's greeting / reprompt phrase, or 404 when TTS is disabled. |
| `POST /api/voice/talk/session` | `{event:"start"\|"end", turns?, reason?}` — Kelly Talk session telemetry. |
| `GET /vendor/vad/<name>` | Allowlisted Silero/onnxruntime-web static assets for Kelly Talk. |
| `GET /voice` | Owner review page. Redirects a `counter`-role request to `/counter` when `counterMode` is `"conversation"` or `"talk"`. |
| `GET /counter` | Customer-facing counter tablet page: `counter.html` or `talk.html` depending on `counterMode` (see above). |
| `GET /talk` | Direct alias that always serves `talk.html`. |
| `GET /api/usage` | Seven-day usage summary from the activity journal and the cooldown ledger, including `talk: {sessions, turns}`. |
| `GET /api/events` | Server-sent events: `activity`, `resources`, `agent`. |

All routes sit behind the dashboard's authentication like every other route.
