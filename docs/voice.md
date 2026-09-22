# Voice on Kelly

Voice is intended to make routine shop work usable while hands are occupied: ask
for a quotation, compare catalogue alternatives, or capture a customer request in
the language people actually use at the counter. Speech recognition is an input
method, not an authority source. Product names, quantities, prices, and customer
intent still need the same validation and approval as typed requests; generated
quotations and external messages remain behind Kelly's existing review gates.

## Local model direction

The recommended starting pair is **whisper.cpp multilingual `small` in a
`small-q5_1` quantized model for transcription (about 181 MB), plus
**Kokoro-82M through kokoro-onnx for speech output** (about 92 MB int8 model
and 28 MB voices file). The worker's Python environment belongs under the local
`data/voice/venv`; dependencies and model assets stay out of the repository.
Whisper's multilingual model can be asked to recognize
automatically or with Hindi/English hints. Transcription is recognition only:
Kelly must not translate or transliterate the words. Keep Whisper's native output,
including Devanagari and mixed Latin technical terms, visible for correction before
consequential actions.

Kokoro-82M is Apache-2.0 and its official voice catalogue lists four Hindi voices,
including `hf_alpha`. The catalogue also notes that Hindi voice data is limited
and that non-English support can be weaker; a published voice list is not a
quality guarantee for Hindi/Hinglish shop speech. kokoro-onnx supplies the local
ONNX runtime path and is MIT-licensed. The persistent worker runs as
`scripts/voice/kokoro_server.py --model <path> --voices <path> --port <port>`
(default port `8765`). Start it with `kelly voice serve`; the command resolves
the script from the Kelly repository, checks local model paths and loopback URL,
and spawns Python with `shell: false`. Set `KELLY_VOICE_PYTHON` to the local
virtualenv Python if it is not at `data/voice/venv/bin/python`. The worker binds
only to `127.0.0.1`, exposes authenticated `GET /health` and `POST /synthesize`,
and requires a bearer token on both routes. Do not expose it to a LAN or the
public internet.

Hinglish performance, especially electrical product names, abbreviations,
quantities, and noisy-counter recordings, has **not yet been benchmarked**.
Treat this as a practical baseline to evaluate, not a verified best-quality
claim. Before relying on it, compare a consented, representative set of shop
clips against human transcripts, report Hindi/English/Hinglish results
separately, and test noisy audio and catalogue vocabulary. Do not upload private
customer audio to third-party services for evaluation without authorization.

An `espeak-ng` command-line voice may be useful as an optional, lightweight,
offline fallback where model storage or memory is constrained. It is distinctly
robotic and is not Kelly's natural-speech recommendation. Do not automatically
download speech models: the current target device is arm64 with roughly 6.7 GB
of free disk, and model/runtime sizes should be checked before installation.

Piper's reviewed Hindi voice datasets carry non-commercial/share-alike terms, so
Kelly does not recommend installing those voices automatically for a business
use case. Future candidates such as IndicF5 (MIT) and Indic Parler (Apache-2.0)
may merit a later benchmark, but are heavier and their model weights/access
conditions must be checked before use.

## Configuration and operation

For one-command startup, run `kelly start`. On macOS it opens a Terminal window
for the dashboard and local speech worker. Run `kelly start --foreground` to
keep them in the current terminal. Ctrl+C stops both, including the Python
worker. The launcher loads this repository's `.env` from any working directory,
checks model files and ports, and prints the URLs after both services respond.
It recognizes already-installed models under `data/voice/models/` and
`whisper-cli` on PATH. If no worker token is configured, it generates a temporary
secret shared only by the two child processes, without writing it to `.env`.
It does not install models or enable a remote tunnel. An occupied port is an
error rather than permission to kill or replace an existing service.

For the fictional catalogue, see `examples/demo/README.md` and run
`kelly start --demo`. Demo state and memory are separate; its dashboard uses
port 7338. Voice recognition quality still needs testing with your own samples.

Copy only the settings needed for the chosen local services into Kelly's private
`.env`; do not commit real endpoints with credentials, tokens, or customer data.
The Kokoro worker's URL should be loopback and `KELLY_KOKORO_TOKEN` must be a
high-entropy local secret shared with that worker. Never print the token in
status output or logs. A missing or unreachable worker should produce a clear
error, not silently route speech or text to a cloud service. Kelly's primary
brain remains Codex and must not acquire a Claude or other provider fallback as
part of voice support.

Example settings are in [`KELLY.env.example`](../KELLY.env.example). Download
and place model files deliberately, then set `KELLY_KOKORO_MODEL_PATH` and
`KELLY_KOKORO_VOICES_PATH`; `kelly voice serve` never downloads weights. Run
`kelly voice serve` in a terminal, then use the dashboard `/voice` surface.
`kelly voice status` reports whether transcription paths are configured and
whether the authenticated Kokoro worker is reachable; it does not measure
recognition or voice quality.

## Speech latency: early spoken event, chunked synthesis, warm-up, timing

A voice turn's reply is instructed to lead with a ```` ```spoken ```` fence (the very first
thing in the reply, not the last) containing the one or two sentences meant for
text-to-speech. `POST /api/chat/send`'s SSE loop watches the streamed reply for that fence:
as soon as its closing ` ``` ` arrives, an `event: spoken` with `{text}` (normalised through
`stripForSpeech`) fires once — before the rest of the reply has necessarily finished
streaming — and the fenced characters never appear in a `token` event. If the reply turns
out not to open with the fence, everything buffered flushes straight through as ordinary
`token` text instead. `done`'s own `spoken` field (quote-aware, built from the full response)
is unchanged, for a client that only waits for completion.

`POST /api/voice/speak` accepts an optional `{ chunk: true }`. With it, the text is split
into sentences (`.`, `?`, `!`, and the Hindi/Devanagari danda `।`) and each is synthesised
and written in turn — so playback can start on the first sentence instead of waiting for the
whole reply to be spoken. The response is `content-type: application/x-kelly-wav-seq`: a
plain sequence of frames, no multipart parser needed — each frame is a 4-byte big-endian
length prefix followed by that many bytes of one complete WAV file. Read the length, read
that many bytes, repeat until the stream ends. Without `chunk`, the route is unchanged: one
request, one WAV response.

When Kokoro is configured, the dashboard synthesises "Ready." once in the background at
startup and discards it — Kokoro's first real synthesis is measurably slower than the rest,
and this absorbs that cost before a customer ever hears it. It records one
`voice.tts.warm` activity event with `{ms}`; a cold or unreachable worker at startup is not
an error (the first real request still tries its own synthesis).

Every synthesis call — chunked (once per sentence) or not — records a `voice.tts` activity
event with `{chars, ms, sentence: true|false}`. `GET /api/usage` folds these into
`voice.ttsChars`, `voice.ttsMs`, and `voice.ttsP50MsPer100Chars` (the median of
`ms / chars * 100` across samples); the switchboard's Usage pane shows this as a "speech: N
chars, p50 ms per 100 chars" line next to the whisper real-time factor.

## References

- [Kokoro-82M official voice catalogue](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)
- [kokoro-onnx project and model/runtime notes](https://github.com/thewh1teagle/kokoro-onnx)
