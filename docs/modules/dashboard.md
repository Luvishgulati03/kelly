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

## Counter mode

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

- **Greeting / reprompt / filler audio** — `GET /api/voice/greeting`, `GET /api/voice/reprompt` and `GET /api/voice/filler?v=N`
  synthesise each trade's fixed phrase (`<shop>` substituted from `config.shopName`) **once
  per process** and cache the WAV bytes in memory and on disk under
  `<dataDir>/voice/cache/<sha256 of the text>.wav`, so a restart is instant. Both routes 404
  with a JSON body when TTS is disabled. Both are warmed best-effort at dashboard startup,
  immediately after the existing Kokoro "Ready." warm-up, logging `voice.tts.warm` with
  `{kind: "greeting" | "reprompt", ms}`.
- **Speech detection** — Silero VAD v5 (`@ricky0123/vad-web` 0.0.31 + `onnxruntime-web`, served
  from `/vendor/vad/*`, see below), with the page's own energy-level VAD as the automatic
  fallback if the bundle 404s or `MicVAD` fails to initialise. Silero is handed the session's
  one microphone stream (`getStream`/`resumeStream` return it, `pauseStream` is a no-op, it
  shares the meter's `AudioContext`), because the library's defaults would open a second
  microphone and stop the tracks on pause. It runs only while listening and is paused while
  Kelly speaks (half-duplex). Its timing is in milliseconds in this version: `minSpeechMs`
  250, `preSpeechPadMs` 300, `redemptionMs` 700, switched to 1400 mid-utterance once the person
  has talked for 4 s (`setOptions`); the 25 s hard cap submits the speech so far by pausing
  with `submitUserSpeechOnPause`. Thresholds 0.55 speech-start / 0.35 speech-end. The energy
  fallback uses a 0.12 RMS threshold with the same 250 ms / 700 ms / 1400 ms / 25 s rules.
  An 8 s silence re-prompts ("Still there?"); a further 15 s ends the session with a chime.
  A press on the orb while Kelly is speaking interrupts her and returns to listening.
- **One conversation per session** — each press creates a conversation (`POST
  /api/conversations`, titled "Talk HH:MM") and every turn of that session carries its
  `conversationId`, so one customer's order never answers the next customer's question.
- **Holding phrases** — when a model turn has not produced a spoken line 1.2 s after the
  question was sent (about 3.5 s after the customer stopped, since transcription takes ~2 s),
  the page plays one of the trade's `fillers` ("One moment, let me check.") from `GET
  /api/voice/filler?v=N` (cached exactly like the greeting and warmed at startup), and one
  more at 12 s. The gallery fast path answers in milliseconds and never hears one.
- **Reply speech queue** — a Codex turn can send more than one spoken line (an acknowledgement,
  then the answer). The page queues them per turn: lines play in order, a line waits for a
  filler that is already playing, nothing cuts anything off, and the mic stays muted until
  the turn has finished and the queue is empty (the orb shows Thinking between lines). A
  press while Kelly speaks, or between two of her lines, drops the rest of that turn
  (including the chat stream) and listens; a stale turn can never change a newer one.
- **Embedded in chat** — `/talk?embed=1&conversationId=<id>&captions=1` joins the owner's open
  conversation instead of creating one, and posts `{type:"kelly-talk", event:"turn"|"ended",
  conversationId}` to `window.parent` (same origin only); the chat page's Talk overlay uses it
  to refresh the thread live.
- **Dropped from the plan** — ending the turn sooner or later depending on the last word
  ("aur", "and") needs live partial transcripts; whisper.cpp only transcribes after the person
  stops, so the rule is not implemented. The 4 s length rule covers the long-request case.
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
- Still planned: tuning the thresholds above against real shop-floor audio (no published
  Hindi or Hinglish numbers exist; these are general defaults made more conservative), voice
  barge-in (today only a press interrupts), and the quotation PDF (tracked in `context.md`).
  Latency per stage is measured by `scripts/talk-bench.mjs` (see `docs/talk-latency.md`).

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
