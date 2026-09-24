# Talk latency benchmark

`scripts/talk-bench.mjs` measures every stage of a Kelly Talk turn against a
running Kelly dashboard, so the next latency fix can be picked with numbers
instead of a guess. It uses only Node built-ins (`fetch`, streams) — no new
dependency.

## Running it

Boot your own Kelly instance on ports that are **not** the owner's live demo
(7338 dashboard / 8765 Kokoro). For example:

```bash
KELLY_PORT=7397 KELLY_HOST=127.0.0.1 KELLY_KOKORO_URL=http://127.0.0.1:8766 \
  node bin/kelly.mjs start --foreground --demo --trade boutique
```

Then, once it logs "Kelly is ready":

```bash
node scripts/talk-bench.mjs --base http://127.0.0.1:7397 --runs 3 --prompts boutique
```

Flags:

- `--base <url>` — dashboard base URL (default `http://127.0.0.1:7338`; always
  point this at your own throwaway instance, never the owner's demo).
- `--token <dashboard token>` — sends `authorization: Bearer <token>`. Omit it
  to rely on the loopback local-admin bypass (see "Auth" below).
- `--runs <n>` — repetitions per prompt (default 3); the table prints every
  run plus the per-column median.
- `--prompts default|boutique|electrical` — which prompt set to use (`default`
  is the boutique set). Boutique: "show me lehenga designs", "show me
  trending sarees", "how much for two salwar suits with lining, my own
  fabric, needed by Friday". Electrical: "show me MCB options", "quote 10
  pieces of 16A MCB, cheapest brand".
- `--json out.json` — also writes the full per-run results as JSON.

Any WAV files the script synthesizes as input speech are written to the
ignored `data/.tmp-shots/` scratch directory and are safe to delete.

## What each stage does, per prompt

1. **Synthesize the prompt as audio** — `POST /api/voice/speak {text,
   language:"en"}` (no `chunk`), returning one complete WAV. The script parses
   the RIFF header and, if the WAV isn't already 16 kHz mono 16-bit PCM,
   linearly resamples it in Node (no dependency) before sending it on.
2. **STT** — `POST /api/voice/transcribe` with that WAV,
   `content-type: audio/wav`, `x-kelly-voice-language: auto`. Times the whole
   request/response as `stt ms`, and compares the transcribed text against the
   original prompt with a simple word-level Levenshtein distance (`WER`,
   roughly word error rate — not a substitute for a real ASR eval, just a
   sanity signal that STT round-tripped the words).
3. **Chat turn** — a fresh `POST /api/conversations {title:"bench"}`, then
   `POST /api/chat/send {prompt:<transcribed text>, voice:true, transcriptId,
   conversationId}`, reading the SSE stream and timing elapsed-since-send at
   each of: first `token`, first `spoken`, `designs` (if any), and `done`
   (plus `done.provider`, e.g. `fastpath`, `codex`, `local`).
4. **TTS of the reply** — if `done.spoken` (or an earlier `spoken` event) is
   present, `POST /api/voice/speak {text:spoken, language:"en", chunk:true}`,
   timing time-to-first-complete-frame (`tts 1st frame ms`, a 4-byte
   big-endian length prefix + one full WAV) and total stream time
   (`tts total ms`).
5. **Greeting** — `GET /api/voice/greeting` twice, to separate the warmed
   cache (`greeting cached ms`) from a cold synthesis (`greeting cold ms`,
   only actually cold on the very first call after the dashboard boots — the
   dashboard also pre-warms this at startup, so a "cold" call mid-run is
   usually already cheap; see `docs/voice.md`).

## Table columns

| Column | Meaning |
| --- | --- |
| `stt ms` | Round-trip time of `POST /api/voice/transcribe`. |
| `1st token ms` | Elapsed time from `chat/send` request to the first SSE `token` event. |
| `1st spoken ms` | Elapsed time to the first SSE `spoken` event (only fires when the reply opens with a ` ```spoken ` fence — the gallery fast path never emits it, only `done.spoken`). |
| `designs ms` | Elapsed time to the SSE `designs` event, when the turn returns gallery images. |
| `done ms` | Elapsed time to the SSE `done` event (full reply committed). |
| `provider` | `done.provider` — e.g. `fastpath` (local gallery-browse reflex, no model call), `local` (reflex/approval), or `codex` (a real model turn). |
| `tts 1st frame ms` | Time from the chunked `/api/voice/speak` request to the first complete WAV frame being readable. |
| `tts total ms` | Total time for the chunked `/api/voice/speak` stream to finish. |
| `greeting cold ms` / `greeting cached ms` | First vs. second `GET /api/voice/greeting` call in the same run. |
| `WER` | Word-level edit distance between the prompt and the transcribed text, divided by prompt word count. |
| `total ms` | `stt ms + (1st spoken ms, or done ms if no spoken event) + tts 1st frame ms` — an approximation of "customer stops speaking" to "Kelly's voice starts answering." |

Each prompt's runs are followed by a `median` row over the requested `--runs`.

## Auth

If `--token` is given, the script sends `authorization: Bearer <token>`.
Without a token, whether the request is treated as an authenticated admin
depends on `src/dashboard/server.ts`'s `sessionUserFor` /
`localAdminBypassEnabled`: with no session cookie and no valid remote token,
a **loopback** request is granted the synthetic local-admin identity
(`SYNTHETIC_ADMIN`) as long as `dashboard.auth.localAdminBypass` is not set to
`false` in `data/settings.json` *and* no tunnel is active
(`runtime.tunnel.active` / `KELLY_TUNNEL` other than `"off"`). That is exactly
this benchmark's situation when run against a local `--demo` instance with no
tunnel configured — so `--token` can be omitted for local runs, and the table
above prints `auth=loopback-bypass` in that case.

## Measured numbers (2026-09-24, this Mac)

Measured against a throwaway `--demo --trade boutique` instance started with
`KELLY_PORT=7397`, `KELLY_HOST=127.0.0.1`, `KELLY_KOKORO_URL=http://127.0.0.1:8766`
(never the owner's live demo on 7338/8765, which was running the whole time and
was left untouched). Two runs per prompt (`--runs 2`). Per
`data/demo-boutique/data/activity.jsonl`'s `run.started`/`run.completed`
entries for these two runs, the "salwar suits" quote turn ran on Codex tier
`t1`, model `gpt-5.6-sol`, with `durationMs: 25681` (`firstTextMs: 11445`) and
`durationMs: 35020` (`firstTextMs: 16782`) respectively — consistent with the
`done ms` column below (SSE `done` fires slightly after the provider's own
`run.completed`, once Kelly's own post-processing finishes):

```
Prompt: "show me lehenga designs"
run | stt ms | 1st token ms | 1st spoken ms | designs ms | done ms | provider | tts 1st frame ms | tts total ms | greeting cold ms | greeting cached ms | WER | total ms
1   | 2241   | 21            | -             | 21         | 21      | fastpath | 1878             | 1878         | 3433              | 2                   | 0.00 | 4140
2   | 1596   | 6             | -             | 6          | 6       | fastpath | 1507             | 1507         | 3                 | 3                   | 0.00 | 3109
median | 1919 | 14           | -             | 14         | 14      | -        | 1693             | 1693         | 1718              | 3                   | -    | 3625

Prompt: "show me trending sarees"
run | stt ms | 1st token ms | 1st spoken ms | designs ms | done ms | provider | tts 1st frame ms | tts total ms | greeting cold ms | greeting cached ms | WER | total ms
1   | 1273   | 46            | -             | 46         | 46      | fastpath | 1763             | 1763         | 2                 | 4                   | 0.00 | 3082
2   | 1805   | 49            | -             | 49         | 49      | fastpath | 1636             | 1636         | 3                 | 2                   | 0.00 | 3490
median | 1539 | 48           | -             | 48         | 48      | -        | 1700             | 1700         | 3                 | 3                   | -    | 3286

Prompt: "how much for two salwar suits with lining, my own fabric, needed by Friday"
run | stt ms | 1st token ms | 1st spoken ms | designs ms | done ms | provider | tts 1st frame ms | tts total ms | greeting cold ms | greeting cached ms | WER  | total ms
1   | 2215   | 23089         | 11818         | -          | 26192   | codex    | 4228             | 9261         | 6                 | 2                   | 0.00 | 18261
2   | 2293   | 32266         | 16914         | -          | 35270   | codex    | 3486             | 8595         | 8                 | 2                   | 0.00 | 22693
median | 2254 | 27678        | 14366         | -          | 30731   | -        | 3857             | 8928         | 7                 | 2                   | -    | 20477
```

(`designs ms` is `-` for the salwar-suits quote turn: it's a pricing answer,
not a gallery browse, so no `designs` event fires. `1st spoken ms` is `-` for
the two gallery-browse prompts: the fast path never opens with a ` ```spoken `
fence — it only sets `done.spoken` directly — so the `spoken` SSE event never
fires for it, and `total ms` falls back to `done ms` in the formula.)

WER was 0.00 on every run: Whisper round-tripped these short, clearly-spoken
English prompts exactly.

## Interpretation

- **Gallery-browse prompts ("lehenga designs", "trending sarees") are already
  fast and STT-dominated.** They hit `runtime.trade.galleryCategories.length`
  → `galleryFastPath`, which never calls a model — `done` fires in 6-49 ms.
  The real cost is STT (1.3-2.2s) plus Kokoro TTS to the first frame
  (1.5-1.9s), for a ~3.1-4.1s total. This path is already the "lighter than a
  model call" option the other two levers exist to approximate; there isn't
  much left to cut here except STT/TTS themselves.
- **A real quote turn ("two salwar suits...") is dominated by the model call,
  by roughly an order of magnitude.** `1st token` alone was 23-32s, and
  `done` 26-35s — that's Codex doing pricing/commerce reasoning, not
  infrastructure overhead. TTS-to-first-frame (3.5-4.2s) and STT (~2.2-2.3s)
  are real but small next to it.
- **Given that, the highest-leverage next fix is shrinking model turn-around
  time for counter-style, non-research quote turns** — e.g. routing them to a
  faster/lighter Codex tier the way `classifyIntentTier`/`isLongResearchAsk`
  already route simple asks to the interactive/delegated split (see
  `src/dashboard/server.ts` around the `runtime.startInteractiveTurn` vs
  `runtime.agent.run` branch). A faster tier for these "quote a customer"
  turns would cut the single biggest number in this table without touching
  voice at all.
- **A lighter Kokoro model would help every turn a little (both the TTS
  columns), but not the dominant one.** Even a 2x TTS speedup only saves ~2s
  on the quote turn versus ~25s spent in the model; it's worth doing but
  won't change which stage dominates.
- **The gallery fast path already demonstrates the ceiling of "skip the
  model entirely"**: 6-49 ms for `done`. Extending that reflex/fast-path
  pattern to more deterministic counter asks (where the answer can be
  computed from local catalogue/commerce state without a model call, per
  `docs/architecture.md`'s reflex lane) is the other lever that doesn't
  require a faster or lighter model at all — it just needs more turns to
  qualify for the existing fast lane.
