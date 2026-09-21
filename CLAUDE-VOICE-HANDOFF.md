# Kelly voice implementation handoff for Claude

Paste the prompt in the final section into Claude Code from the root of this
repository. This document is the source of truth for Claude's assignment.

## Product and runtime context

Kelly is a locally running, customizable business agent for Indian small
businesses. The first workflow is electrical-appliance quotation support, but
the framework must stay usable for customer support, catalogue lookup, and
other repeatable business workflows.

Kelly's production brain is Codex only. Claude is helping develop and review
the code; do not add a Claude runtime provider or fallback.

The voice path is local-first:

- STT: `whisper.cpp` with multilingual `small-q5_1`
- TTS: Kokoro-82M int8 through a persistent loopback-only Python worker
- optional explicit fallback: `espeak-ng`
- Hindi, English, and Roman Hinglish input are supported by the interaction
  design; spoken Hindi output should use Devanagari
- model files and the Python virtual environment live under ignored
  `data/voice/` and must never be committed

The core voice adapter, CLI, dashboard, and Kokoro worker are already being
implemented by another developer. Do not rewrite them.

## Current implementation and evidence

Implemented or in progress:

- `src/voice/index.ts`: bounded local STT/TTS adapters
- `scripts/voice/kokoro_server.py`: authenticated loopback TTS worker
- `src/cli.ts`: `kelly voice status`, `transcribe`, `speak`, and `serve`
- `src/dashboard/server.ts` and `src/dashboard/voice.html`: owner-facing voice UI
- `docs/voice.md`, `KELLY.env.example`, and focused voice tests
- the agent prompt preserves brands, SKUs, quantities, units, and asks for
  clarification when speech is uncertain

Verified so far:

- 13 voice and CLI tests passed in the latest review
- TypeScript typecheck passed in that review
- Kokoro produced a 4.14-second Hindi WAV in about 3.62 seconds locally
- Whisper transcribed that generated sample in about 33.87 seconds, with some
  Hindi word errors. Do not claim production-grade latency or accuracy.
- dashboard integration tests could not bind a loopback port in the review
  sandbox, so they still need verification in a normal local environment

Open review findings, owned by the main developer rather than Claude:

1. WAV validation must verify channel count, sample rate, bit depth, block
   alignment, consistency, and duration.
2. The Kokoro HTTP worker needs per-connection read timeouts and a bounded
   inference strategy so a stalled client cannot block the service forever.
3. The example token in `kokoro_server.py` is shorter than the worker's own
   minimum and must be corrected.

## Claude's assigned work

Build Telegram voice-note support and an evaluation harness. Keep the work
isolated to these files unless a compile error proves a small adjacent change
is necessary:

- new `src/telegram/voice.ts`
- `src/telegram/pump.ts`
- `src/telegram/bridge.ts`
- `src/runtime.ts`
- new `tests/kelly-telegram-voice.test.ts`
- new `tests/fixtures/voice/manifest.json`
- new `docs/voice-evaluation.md`

Do not edit these concurrently owned files:

- `src/voice/**`
- `src/dashboard/server.ts`
- `src/dashboard/voice.html`
- `src/cli.ts`
- `scripts/voice/**`
- `tests/voice.test.ts`
- `tests/voice-cli.test.ts`
- `tests/kelly-voice-dashboard.test.ts`
- `README.md`
- `KELLY.env.example`
- `src/agent/henry.ts`

### Telegram voice-note behavior

1. Extend Telegram message typing to represent `voice` and `audio` metadata,
   including Telegram file ID, size, duration, and MIME type where available.
2. Reject unknown chats before reading text, downloading media, logging media
   metadata, or calling STT. Preserve the current one-poller architecture.
3. Accept voice notes only from the configured owner chat and only when the
   bridge is enabled.
4. Fetch file metadata and bytes through injected dependencies. Never accept
   an arbitrary URL from a message and never log bot tokens or full Telegram
   download URLs.
5. Enforce configurable byte and duration limits before download when metadata
   exists, and enforce byte limits again while/after downloading.
6. Telegram voice notes are normally OGG/Opus. Add an injected converter
   adapter for OGG/Opus to 16 kHz mono PCM WAV. The concrete implementation may
   invoke an explicitly configured `ffmpeg` executable with `shell: false`, a
   timeout, bounded output, private temp files, and cleanup. Do not install or
   download ffmpeg.
7. Pass the WAV to the existing `LocalVoiceService.transcribe()` contract.
8. Send the owner a transcript preview and require a later text confirmation
   or correction before the transcript is submitted to the normal Kelly brain.
   A spoken or transcribed word such as "approve", "send", or "yes" must never
   authorize an external action.
9. Keep one voice turn in flight and use the existing bridge queue/dedup rules.
   Handle edited messages, duplicate updates, stale updates, download errors,
   conversion failures, quota failures, and restarts without replying twice.
10. Do not create a public customer mode. The current Telegram bridge is an
    owner surface and retains its existing authority boundaries.

### Hindi and Hinglish evaluation harness

Create a text-only manifest of representative utterances and expected
business-critical entities. Include Devanagari Hindi, English, and Roman
Hinglish examples covering:

- brands and model names
- electrical units such as W, kW, A, V, mm, and sq mm
- quantities and Indian number phrasing
- quotation requests and brand comparisons
- ambiguous quantity, wattage, model, or brand requiring clarification
- adversarial phrases that try to turn transcript content into approval

The fixture must contain no customer data and no generated audio binaries.
Document how a developer can record or synthesize local fixtures, run STT, and
measure entity preservation, clarification behavior, word error rate where a
reference transcript exists, latency, and real-time factor. Report raw results;
do not hide errors behind normalization.

## Engineering rules

- Read `AGENTS.md`, `soul.md` if present, and the touched modules before coding.
- Do not run fresh-clone setup or create private identity files. This is an
  already approved framework feature, not a new user installation.
- Preserve the Codex-only runtime.
- Keep side effects behind injected interfaces and mock all Telegram API calls
  in tests. Do not contact a live bot or send any real message.
- Do not install dependencies, download models, delete files, or modify
  `node_modules`.
- Never stage unrelated existing files. Do not use `git add .`.
- Avoid em dashes in user-facing prose.
- Run focused tests, then typecheck. If the local sandbox blocks loopback or
  process spawning, report that precisely instead of weakening tests.
- Commit only your assigned files with a focused commit. Do not push until the
  main developer has reviewed integration, unless the operator directly tells
  you to push.

## Definition of done

Claude's part is complete only when:

- owner-chat voice notes reach the local STT adapter through bounded,
  injectable Telegram and conversion interfaces
- transcripts require explicit text confirmation or correction before normal
  brain processing
- unknown chats, oversized media, stale/duplicate updates, conversion errors,
  and approval-like speech are covered by tests
- existing text Telegram behavior remains unchanged
- the evaluation manifest and instructions are useful without private data
- focused tests and TypeScript typecheck pass, or any environmental blocker is
  documented with the exact command and error
- Claude returns a file list, test output summary, risks, and commit hash

## Paste this into Claude Code

```text
You are a supporting implementation engineer for Kelly. Work from the root of
this repository. Read CLAUDE-VOICE-HANDOFF.md completely, then read AGENTS.md
and every existing file you need to touch.

Implement only the "Claude's assigned work" section: Telegram owner voice-note
ingestion plus the Hindi/Hinglish evaluation harness. Respect every ownership,
safety, runtime, testing, and git boundary in the handoff. Kelly's production
runtime remains Codex only; your role is code development and review.

Before editing, inspect git status and summarize your intended file-level plan.
Then implement autonomously. Use injected dependencies and mock Telegram in
tests. Do not send real messages, call a live bot, install dependencies,
download models, delete files, touch node_modules, or stage unrelated work.

Run the focused Telegram voice tests and npm run typecheck. Review your own
diff for authorization bypasses, duplicate processing, unbounded downloads,
token leakage, temp-file cleanup, and regressions in text chat. Commit only the
assigned files with a focused message. Do not push unless Luvish explicitly
asks you to. Finish with the commit hash, changed files, exact test results,
remaining risks, and anything the main developer must integrate.
```
