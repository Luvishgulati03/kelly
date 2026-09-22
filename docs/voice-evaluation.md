# Evaluating Kelly's Hindi and Hinglish speech input

Speech recognition is an input method, not an authority source. This document explains how
to find out how well it actually works for shop speech before anyone relies on it. The
fixture set is [`tests/fixtures/voice/manifest.json`](../tests/fixtures/voice/manifest.json):
22 utterances in Devanagari Hindi, English and Roman Hinglish, each with the entities that
must survive transcription.

Nothing here is a benchmark result. Hinglish performance on electrical vocabulary has not
been measured, and one early local sample took about 34 seconds to transcribe roughly 4
seconds of synthetic Hindi speech with word errors. Treat that as a starting point to
improve, not a baseline to quote.

## What the manifest contains, and what it does not

The manifest is text only. It contains no customer data, no names, no phone numbers, and no
real quotation values, and it commits no audio. Each case carries:

- `utterance`: what a person says.
- `expect`: the brands, models, quantities, units and intent the transcript must preserve.
- `requiresClarification`: true when the correct behaviour is to ask rather than guess.
- `mustNotAuthorize`: true for speech that tries to approve, send, or publish something.

Entity preservation matters more than word-perfect transcription. "Do Havells ke pankhe"
transcribed as "2 Havells ke pankhe" is a success. The same line transcribed as "Havells ke
pankhe" has lost the quantity and is a failure even though only one short word changed.

## Recording or synthesizing local fixtures

Audio stays out of the repository. Put it under ignored `data/voice/eval/`, named by case id:

```bash
mkdir -p data/voice/eval
```

**Recorded (preferred).** Record each utterance with the microphone and room you actually
use, in the accents of the people who will speak to Kelly. Get consent from anyone recorded,
and never record a customer conversation for this purpose. Aim for a handful of speakers
rather than one, and include at least one noisy counter recording per category.

```bash
# macOS example: 16 kHz mono WAV is what the transcriber wants.
ffmpeg -f avfoundation -i ":0" -ac 1 -ar 16000 -t 12 data/voice/eval/hi-quote-fan-havells.wav
```

**Synthesized (a weak substitute).** Kelly's own speech engine can read the utterances back,
which is repeatable and costs nothing, but synthetic speech is cleaner than real speech and
will flatter the results. Use it to shake out the pipeline, not to judge accuracy.

```bash
kelly voice speak "हैवेल्स के दो सीलिंग फैन का कोटेशन बना दो" --language hi --out data/voice/eval/hi-quote-fan-havells.wav
```

Keep a `reference.txt` beside each clip containing exactly what was said. Without a reference
transcript you can still measure entity preservation, but not word error rate.

## Running transcription

```bash
kelly voice status
kelly voice transcribe data/voice/eval/hi-quote-fan-havells.wav --language auto
```

Use `--language auto` for the Hinglish cases. Forcing `hi` or `en` on mixed speech changes
the result, so if you compare language hints, report each setting separately rather than
keeping the best one.

For the Telegram surface, send the same clips as voice notes from the owner account and check
that the transcript preview matches the CLI result. That path adds an OGG/Opus to WAV
conversion step, so a difference between the two is a conversion problem, not a model problem.

## Telegram surface settings

The owner voice-note surface reads these from the environment. It stays off unless both local
speech recognition and an explicit ffmpeg are configured, and it never installs either.

| Setting | Default | Meaning |
| --- | --- | --- |
| `KELLY_FFMPEG_PATH` | unset, required | Existing ffmpeg executable, used to convert Telegram's OGG/Opus to 16 kHz mono WAV. |
| `KELLY_TELEGRAM_VOICE` | on | Set to `0` to refuse voice notes while leaving the rest of voice alone. |
| `KELLY_TELEGRAM_VOICE_MAX_BYTES` | 20971520 | Refused before download when the declared size is larger, and again while downloading. |
| `KELLY_TELEGRAM_VOICE_MAX_SECONDS` | 300 | Refused before download when the declared duration is longer. |
| `KELLY_TELEGRAM_VOICE_LANGUAGE` | `auto` | Transcription hint. Leave on auto for mixed Hindi and English speech. |
| `KELLY_TELEGRAM_VOICE_REPLIES` | off | Set to `1` to also receive short answers as a voice note. Needs local synthesis configured. |

The same settings are included in `KELLY.env.example` alongside the other local voice
configuration.

A transcript is never acted on by itself. Kelly reads it back and waits for a typed yes, so a
spoken "approve" or "send" cannot authorize anything. Spoken replies are text-first: the
written answer is always delivered, and speech is a best-effort extra that is skipped for long
answers because local synthesis costs roughly real time.

## What to measure

Record these per case, then aggregate per language and per category. Keep the raw table.

1. **Entity preservation.** For each expected brand, model, quantity and unit, was it present
   in the transcript? Report exact match and a normalized match (case folded, digits and
   number words treated as equal) as two separate numbers. Never report only the normalized
   figure: normalization is where mistakes go to hide.
2. **Quantity and unit accuracy.** Count wrong values separately from missing ones. A wrong
   quantity produces a confident, wrong quotation, which is worse than a missing one.
3. **Clarification behaviour.** For `requiresClarification` cases, did Kelly ask instead of
   assuming? Count silent guesses as failures even when the guess happens to be right.
4. **Authorization safety.** For `mustNotAuthorize` cases, confirm that nothing was sent,
   approved, or published, and that the transcript still required a typed confirmation.
   Any failure here is a release blocker, not a quality metric.
5. **Word error rate**, only where a reference transcript exists. Report the substitution,
   deletion and insertion counts alongside the percentage, and report Hindi, English and
   Hinglish separately. A single blended number hides which language is failing.
6. **Latency and real-time factor.** Wall-clock transcription time, and that time divided by
   audio duration. Measure on the machine that will run Kelly, with the models it will use,
   and note whether anything else was running.

## Reporting

Report raw results, including the failures. A useful report states the model and quantization
used, the number of speakers and clips, the recording conditions, per-language entity
preservation, per-language word error rate where available, latency and real-time factor, and
the list of cases that failed with their actual transcripts.

State clearly what has not been tested. If every clip is synthetic, say so, because the
numbers do not then describe counter conditions. If one speaker recorded everything, say so,
because accent coverage is the most common blind spot in this kind of evaluation.

## Native-script display

Kelly displays Whisper's native transcript without transliteration. Hindi can remain in
Devanagari, while English loanwords, brands, model identifiers, measurements and abbreviations
can remain in Latin script when Whisper recognizes them that way. The owner reviews exactly
those words before anything reaches Kelly.

The deterministic converter in `src/voice/roman.ts` is retained for reference and rollback,
but its imports and production calls are intentionally commented out. Legacy records created
while conversion was active can still contain a Roman `text` value and hidden Devanagari
`original`; the dashboard continues to render both safely. New records store native output in
`text` and leave `original` empty.

## Deciding whether it is good enough

Quality is a business judgement, not a threshold in a document. Frame it this way: a
transcription error that Kelly asks about costs a few seconds, while one it acts on silently
can produce a wrong quotation that a customer sees. Until entity preservation on real
recordings is high and clarification behaviour is reliable, keep voice as an input that is
read back for confirmation, which is exactly what the Telegram surface enforces today.
