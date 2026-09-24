#!/usr/bin/env node
// talk-bench.mjs — end-to-end latency benchmark for a Kelly Talk turn against a
// running Kelly dashboard. Node 26 built-ins only (fetch, streams). See
// docs/talk-latency.md for usage, column meanings, and the numbers this has
// measured.
//
// Usage:
//   node scripts/talk-bench.mjs --base http://127.0.0.1:7397 [--token <dashboard token>]
//     [--runs 3] [--prompts default|boutique|electrical] [--json out.json]
//
// Never point this at the owner's real demo (ports 7338/8765) or a production
// Kelly instance without an explicit, approved reason.

import { writeFile, mkdir, writeFile as writeFileP } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { base: "http://127.0.0.1:7338", runs: 3, prompts: "default", json: undefined, token: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base") args.base = argv[++i];
    else if (arg === "--token") args.token = argv[++i];
    else if (arg === "--runs") args.runs = Number(argv[++i]) || 1;
    else if (arg === "--prompts") args.prompts = argv[++i];
    else if (arg === "--json") args.json = argv[++i];
    else if (arg === "--help") { args.help = true; }
  }
  return args;
}

const PROMPT_SETS = {
  boutique: [
    "show me lehenga designs",
    "show me trending sarees",
    "how much for two salwar suits with lining, my own fabric, needed by Friday",
  ],
  electrical: [
    "show me MCB options",
    "quote 10 pieces of 16A MCB, cheapest brand",
  ],
};
// "default" mirrors the boutique set unless the caller asks for electrical explicitly.
PROMPT_SETS.default = PROMPT_SETS.boutique;

// ---------------------------------------------------------------------------
// WAV helpers: parse a RIFF/WAVE buffer, and linearly resample to 16 kHz mono
// 16-bit PCM. No dependencies — this is a small, purpose-built decoder, not a
// general WAV library: it only needs to handle what /api/voice/speak returns
// (PCM or IEEE float, mono or stereo, 8-96kHz, 8/16/24/32 bit).
// ---------------------------------------------------------------------------

function parseWav(buffer) {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE buffer");
  }
  let offset = 12;
  let format, channels, sampleRate, bitsPerSample;
  let dataStart, dataLength;
  while (offset + 8 <= buffer.length) {
    const name = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (name === "fmt ") {
      format = buffer.readUInt16LE(start);
      channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4);
      bitsPerSample = buffer.readUInt16LE(start + 14);
    } else if (name === "data") {
      dataStart = start;
      dataLength = size;
    }
    offset = start + size + (size & 1);
  }
  if (format === undefined || dataStart === undefined || dataLength === undefined) {
    throw new Error("Malformed WAV: missing fmt or data chunk");
  }
  return { format, channels, sampleRate, bitsPerSample, data: buffer.subarray(dataStart, dataStart + dataLength) };
}

/** Read `frame` samples (one per channel) starting at sample index `i` of a parsed WAV, as floats in [-1, 1]. */
function readSampleFrame(wav, i) {
  const { data, channels, bitsPerSample, format } = wav;
  const bytesPerSample = bitsPerSample / 8;
  const frameBytes = bytesPerSample * channels;
  const base = i * frameBytes;
  const out = new Array(channels);
  for (let ch = 0; ch < channels; ch += 1) {
    const at = base + ch * bytesPerSample;
    if (format === 3) {
      // IEEE float
      out[ch] = bitsPerSample === 64 ? data.readDoubleLE(at) : data.readFloatLE(at);
    } else if (bitsPerSample === 8) {
      out[ch] = (data.readUInt8(at) - 128) / 128;
    } else if (bitsPerSample === 16) {
      out[ch] = data.readInt16LE(at) / 32768;
    } else if (bitsPerSample === 24) {
      const b0 = data[at], b1 = data[at + 1], b2 = data[at + 2];
      let v = b0 | (b1 << 8) | (b2 << 16);
      if (v & 0x800000) v -= 0x1000000;
      out[ch] = v / 8388608;
    } else if (bitsPerSample === 32) {
      out[ch] = data.readInt32LE(at) / 2147483648;
    } else {
      throw new Error(`Unsupported bit depth ${bitsPerSample}`);
    }
  }
  return out;
}

/** Convert an arbitrary WAV buffer to 16 kHz mono 16-bit PCM WAV via linear resampling. */
function toPcm16kMono(buffer) {
  const wav = parseWav(buffer);
  const bytesPerSample = wav.bitsPerSample / 8;
  const frameCount = Math.floor(wav.data.length / (bytesPerSample * wav.channels));
  if (wav.sampleRate === 16000 && wav.channels === 1 && wav.bitsPerSample === 16 && wav.format === 1) {
    return buffer; // already in the target format
  }
  // Downmix to mono float samples first.
  const mono = new Float64Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    const frame = readSampleFrame(wav, i);
    let sum = 0;
    for (const s of frame) sum += s;
    mono[i] = sum / frame.length;
  }
  // Linear resample mono -> 16kHz.
  const targetRate = 16000;
  const ratio = wav.sampleRate / targetRate;
  const outLength = Math.max(1, Math.round(frameCount / ratio));
  const resampled = new Int16Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, frameCount - 1);
    const frac = srcPos - i0;
    const s0 = mono[Math.min(i0, frameCount - 1)] ?? 0;
    const s1 = mono[i1] ?? s0;
    const sample = s0 + (s1 - s0) * frac;
    const clamped = Math.max(-1, Math.min(1, sample));
    resampled[i] = Math.round(clamped * 32767);
  }
  return encodeWavPcm16Mono(resampled, targetRate);
}

function encodeWavPcm16Mono(int16Samples, sampleRate) {
  const dataBytes = int16Samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < int16Samples.length; i += 1) buffer.writeInt16LE(int16Samples[i], 44 + i * 2);
  return buffer;
}

// ---------------------------------------------------------------------------
// Word-level Levenshtein / word error rate
// ---------------------------------------------------------------------------

function normalizeWords(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

function wordErrorRate(reference, hypothesis) {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  const m = ref.length, n = hyp.length;
  if (m === 0) return hyp.length === 0 ? 0 : 1;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) dp[j] = j;
  for (let i = 1; i <= m; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const temp = dp[j];
      if (ref[i - 1] === hyp[j - 1]) dp[j] = prev;
      else dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n] / m;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function authHeaders(token) {
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function postJson(base, token, route, body) {
  const started = Date.now();
  const response = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - started;
  if (!response.ok) throw new Error(`${route} -> ${response.status} ${await response.text().catch(() => "")}`);
  return { json: await response.json(), ms };
}

async function getRaw(base, token, route) {
  const started = Date.now();
  const response = await fetch(`${base}${route}`, { headers: authHeaders(token) });
  if (!response.ok) throw new Error(`${route} -> ${response.status} ${await response.text().catch(() => "")}`);
  const buf = Buffer.from(await response.arrayBuffer());
  return { buffer: buf, ms: Date.now() - started };
}

async function speak(base, token, text, { chunk = false } = {}) {
  const started = Date.now();
  const response = await fetch(`${base}/api/voice/speak`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ text, language: "en", ...(chunk ? { chunk: true } : {}) }),
  });
  if (!response.ok) throw new Error(`/api/voice/speak -> ${response.status} ${await response.text().catch(() => "")}`);
  if (!chunk) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return { buffer, totalMs: Date.now() - started };
  }
  // Chunked: application/x-kelly-wav-seq. Each frame is a 4-byte big-endian
  // length prefix followed by that many bytes of a complete WAV file. Time to
  // first complete frame, and total time to end of stream.
  const reader = response.body.getReader();
  let firstFrameMs;
  let frames = 0;
  let pending = Buffer.alloc(0);
  const collected = [];
  const appendChunk = (chunk) => { pending = Buffer.concat([pending, Buffer.from(chunk)]); };
  const tryDrainFrames = () => {
    for (;;) {
      if (pending.length < 4) return;
      const length = pending.readUInt32BE(0);
      if (pending.length < 4 + length) return;
      const frame = pending.subarray(4, 4 + length);
      collected.push(Buffer.from(frame));
      pending = pending.subarray(4 + length);
      frames += 1;
      if (firstFrameMs === undefined) firstFrameMs = Date.now() - started;
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    appendChunk(value);
    tryDrainFrames();
  }
  tryDrainFrames();
  return { buffer: collected[0], totalMs: Date.now() - started, firstFrameMs, frames };
}

async function transcribe(base, token, wavBuffer) {
  const started = Date.now();
  const response = await fetch(`${base}/api/voice/transcribe`, {
    method: "POST",
    headers: { "content-type": "audio/wav", "x-kelly-voice-language": "auto", ...authHeaders(token) },
    body: wavBuffer,
  });
  const ms = Date.now() - started;
  if (!response.ok) throw new Error(`/api/voice/transcribe -> ${response.status} ${await response.text().catch(() => "")}`);
  const json = await response.json();
  return { json, ms };
}

/** Read the /api/chat/send SSE stream, timing first `token`, first `spoken`, `designs`, `done`. */
async function chatSendTimed(base, token, payload) {
  const started = Date.now();
  const response = await fetch(`${base}/api/chat/send`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`/api/chat/send -> ${response.status} ${await response.text().catch(() => "")}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const timings = { firstTokenMs: undefined, firstSpokenMs: undefined, designsMs: undefined, doneMs: undefined };
  let doneEvent;
  const handleEvent = (event, dataRaw) => {
    const elapsed = Date.now() - started;
    let data;
    try { data = JSON.parse(dataRaw); } catch { return; }
    if (event === "token" && timings.firstTokenMs === undefined) timings.firstTokenMs = elapsed;
    else if (event === "spoken" && timings.firstSpokenMs === undefined) timings.firstSpokenMs = elapsed;
    else if (event === "designs" && timings.designsMs === undefined) timings.designsMs = elapsed;
    else if (event === "done") { timings.doneMs = elapsed; doneEvent = data; }
    else if (event === "error") { throw Object.assign(new Error(data.error || "chat/send error"), { sse: data }); }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sepIndex;
    while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      let event = "message";
      let data = "";
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data = line.slice(6);
      }
      handleEvent(event, data);
    }
  }
  return { timings, doneEvent, totalMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function median(values) {
  const clean = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return undefined;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function fmt(ms) {
  return typeof ms === "number" && Number.isFinite(ms) ? String(Math.round(ms)) : "-";
}

// ---------------------------------------------------------------------------
// Single-run benchmark of one prompt
// ---------------------------------------------------------------------------

async function benchOnce(base, token, prompt, { shotsDir }) {
  // 1. Synthesize the prompt as audio (non-chunked -> WAV).
  const speakResult = await speak(base, token, prompt, { chunk: false });
  const sttInput = toPcm16kMono(speakResult.buffer);
  if (shotsDir) {
    await writeFileP(path.join(shotsDir, `prompt-${Date.now()}.wav`), sttInput).catch(() => undefined);
  }

  // 2. Transcribe.
  const { json: transcribeJson, ms: sttMs } = await transcribe(base, token, sttInput);
  const transcribedText = transcribeJson.text || "";
  const wer = wordErrorRate(prompt, transcribedText);

  // 3. Fresh conversation + chat/send, timing SSE milestones.
  const { json: conv } = await postJson(base, token, "/api/conversations", { title: "bench" });
  const conversationId = conv.conversation?.id;
  const chat = await chatSendTimed(base, token, {
    prompt: transcribedText || prompt,
    voice: true,
    transcriptId: transcribeJson.transcriptId,
    conversationId,
  });

  // 4. TTS of the spoken reply (chunked), timing first complete frame + total.
  let ttsFirstFrameMs;
  let ttsTotalMs;
  const spokenText = chat.doneEvent?.spoken;
  if (spokenText) {
    const ttsResult = await speak(base, token, spokenText, { chunk: true });
    ttsFirstFrameMs = ttsResult.firstFrameMs;
    ttsTotalMs = ttsResult.totalMs;
  }

  // 5. Greeting cold vs cached.
  const greetingCold = await getRaw(base, token, "/api/voice/greeting");
  const greetingCached = await getRaw(base, token, "/api/voice/greeting");

  const firstSpokenOrDone = chat.timings.firstSpokenMs ?? chat.timings.doneMs;
  const totalCustomerMs = (sttMs ?? 0) + (firstSpokenOrDone ?? 0) + (ttsFirstFrameMs ?? 0);

  return {
    prompt,
    transcribedText,
    wer,
    sttMs,
    firstTokenMs: chat.timings.firstTokenMs,
    firstSpokenMs: chat.timings.firstSpokenMs,
    designsMs: chat.timings.designsMs,
    doneMs: chat.timings.doneMs,
    provider: chat.doneEvent?.provider,
    ttsFirstFrameMs,
    ttsTotalMs,
    greetingColdMs: greetingCold.ms,
    greetingCachedMs: greetingCached.ms,
    totalCustomerMs,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printTable(prompt, runs) {
  console.log(`\nPrompt: "${prompt}"`);
  console.log(
    ["run", "stt ms", "1st token ms", "1st spoken ms", "designs ms", "done ms", "provider", "tts 1st frame ms", "tts total ms", "greeting cold ms", "greeting cached ms", "WER", "total ms"].join(" | "),
  );
  runs.forEach((r, i) => {
    console.log(
      [
        i + 1,
        fmt(r.sttMs),
        fmt(r.firstTokenMs),
        fmt(r.firstSpokenMs),
        fmt(r.designsMs),
        fmt(r.doneMs),
        r.provider ?? "-",
        fmt(r.ttsFirstFrameMs),
        fmt(r.ttsTotalMs),
        fmt(r.greetingColdMs),
        fmt(r.greetingCachedMs),
        r.wer.toFixed(2),
        fmt(r.totalCustomerMs),
      ].join(" | "),
    );
  });
  const medians = {
    sttMs: median(runs.map((r) => r.sttMs)),
    firstTokenMs: median(runs.map((r) => r.firstTokenMs)),
    firstSpokenMs: median(runs.map((r) => r.firstSpokenMs)),
    designsMs: median(runs.map((r) => r.designsMs)),
    doneMs: median(runs.map((r) => r.doneMs)),
    ttsFirstFrameMs: median(runs.map((r) => r.ttsFirstFrameMs)),
    ttsTotalMs: median(runs.map((r) => r.ttsTotalMs)),
    greetingColdMs: median(runs.map((r) => r.greetingColdMs)),
    greetingCachedMs: median(runs.map((r) => r.greetingCachedMs)),
    totalCustomerMs: median(runs.map((r) => r.totalCustomerMs)),
  };
  console.log(
    [
      "median",
      fmt(medians.sttMs),
      fmt(medians.firstTokenMs),
      fmt(medians.firstSpokenMs),
      fmt(medians.designsMs),
      fmt(medians.doneMs),
      "-",
      fmt(medians.ttsFirstFrameMs),
      fmt(medians.ttsTotalMs),
      fmt(medians.greetingColdMs),
      fmt(medians.greetingCachedMs),
      "-",
      fmt(medians.totalCustomerMs),
    ].join(" | "),
  );
  return medians;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("node scripts/talk-bench.mjs --base http://127.0.0.1:7397 [--token <dashboard token>] [--runs 3] [--prompts default|boutique|electrical] [--json out.json]");
    return;
  }
  const prompts = PROMPT_SETS[args.prompts];
  if (!prompts) throw new Error(`Unknown --prompts value: ${args.prompts} (use default, boutique, or electrical)`);

  const shotsDir = path.join(process.cwd(), "data", ".tmp-shots");
  await mkdir(shotsDir, { recursive: true }).catch(() => undefined);

  console.log(`talk-bench: base=${args.base} runs=${args.runs} prompts=${args.prompts} auth=${args.token ? "token" : "loopback-bypass"}`);

  const results = {};
  for (const prompt of prompts) {
    const runs = [];
    for (let i = 0; i < args.runs; i += 1) {
      const run = await benchOnce(args.base, args.token, prompt, { shotsDir });
      runs.push(run);
    }
    const medians = printTable(prompt, runs);
    results[prompt] = { runs, medians };
  }

  if (args.json) {
    await writeFile(args.json, JSON.stringify(results, null, 2), "utf8");
    console.log(`\nWrote ${args.json}`);
  }
}

main().catch((error) => {
  console.error(`talk-bench failed: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
