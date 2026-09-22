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

## References

- [Kokoro-82M official voice catalogue](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)
- [kokoro-onnx project and model/runtime notes](https://github.com/thewh1teagle/kokoro-onnx)
