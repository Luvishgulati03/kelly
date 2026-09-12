import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSettings } from "../util/settings.ts";

/**
 * Local model client — a zero-dependency HTTP client for an Ollama daemon on the loopback
 * interface. It is the CHEAP layer: work that would otherwise burn a metered claude/codex
 * call (today: the local NER scrub) runs here first, free, so the paid layer stays reserved
 * for the turn the operator is actually waiting on.
 *
 * Two properties this module exists to guarantee:
 *
 *  1. It NEVER throws and never blocks a caller for long. Ollama is optional infrastructure
 *     — not installed, not running, model not pulled, or wedged mid-generation are all
 *     ordinary states. Every entry point resolves to a benign value (`false`, `null`, `[]`)
 *     so a caller's only branch is "did I get something useful?", never a try/catch. A
 *     turn must not fail because a background daemon is down.
 *  2. Availability is CACHED (60s, per URL). Without it every turn pays a connect attempt
 *     against a daemon that is very likely still absent, on the single-threaded request
 *     path. `resetOllamaCache()` exists for tests (and for a caller that just started the
 *     daemon and does not want to wait out the TTL).
 *
 * Privacy note: this module applies NO redaction of its own. Callers are responsible for
 * handing it text that is already safe to log. Loopback-only is not an excuse; the daemon
 * writes prompts to its own logs.
 */

export type OllamaConfig = { url: string; model: string; timeoutMs: number };

/** `llama3.2:3b` fits an 8GB M1 Air, which is the machine this is budgeted for. */
const DEFAULTS: OllamaConfig = { url: "http://127.0.0.1:11434", model: "llama3.2:3b", timeoutMs: 20000 };

/** How long an availability probe's verdict — positive OR negative — is trusted. */
const AVAILABILITY_TTL_MS = 60_000;

/**
 * The probe gets its own, shorter deadline than a generation. `timeoutMs` is sized for a
 * 3B model writing a paragraph; spending that same 20s discovering a wedged daemon would
 * stall a turn for 20s once a minute (the TTL). A daemon that cannot answer
 * `/api/tags` — a constant-time listing — in five seconds is unusable for layer-1 work
 * anyway. A caller asking for LESS than the cap still gets what it asked for.
 */
const PROBE_TIMEOUT_CAP_MS = 5000;

/**
 * Hard ceiling on how much of a daemon's answer is read into memory. `response.json()` /
 * `response.text()` buffer whatever the far end chooses to send, and the thing on the far end
 * is NOT trusted: the module's own premise is that 127.0.0.1:11434 is usually absent, which
 * is precisely what makes it available for any other local process to bind. Measured against
 * a squatter (audit 2026-08-13 M2): a 64MB body cost +288MB RSS in 153ms and a 512MB one
 * +912MB in 783ms, on a machine budgeted at 8GB in total — an OOM of the whole agent, once
 * per turn, well inside `timeoutMs`. A real generation from a 3B model is a few tens of KB,
 * so 4MB is ~100x headroom and still a bound.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Hard ceiling on a NER answer: 20 names is far past any real sentence, so more means the model is rambling. */
const MAX_NAMES = 20;
/** Prompt-size bound for the NER pass — a caller can hand over 4000+ characters and a 3B model degrades badly past that. */
const MAX_NER_INPUT = 4000;

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

// ---------------------------------------------------------------------------
// config resolution (settings local.ollama, overridable per call)
// ---------------------------------------------------------------------------

let settingsPathOverride: string | undefined;

/** Same dataDir resolution as resources.ts/auth.ts, so every module reads ONE settings file. */
function dataDir(): string {
  const configured = process.env.HENRY_DATA_DIR || process.env.LAVU_DATA_DIR || "data";
  return path.isAbsolute(configured) ? configured : path.resolve(REPO_ROOT, configured);
}

function ollamaSettingsPath(): string {
  return settingsPathOverride ?? path.join(dataDir(), "settings.json");
}

/**
 * Points config resolution at a different settings file (tests use a tmpdir), mirroring
 * `configureResources`. Calling it with no argument restores the default path — tests must
 * be able to hand the module back, and a stale override would silently follow a deleted
 * tmpdir. Always drops the availability cache: a new settings file may name a new URL.
 */
export function configureOllama(opts: { settingsPath?: string } = {}): void {
  settingsPathOverride = opts.settingsPath;
  resetOllamaCache();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `local.ollama` block, or `{}` — a missing/corrupt settings file is not an error here. */
function ollamaSettings(): Record<string, unknown> {
  const settings = readSettings(ollamaSettingsPath());
  const local = isRecord(settings.local) ? settings.local : {};
  return isRecord(local.ollama) ? local.ollama : {};
}

function settingsString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function settingsTimeout(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

/** Trailing slashes are stripped once here so every call site can write `${url}/api/...`. */
function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * The local layer's whole premise is that the text never leaves the box (audit 2
 * round REPORTED-ONLY #1): a mistyped `local.ollama.url` must not silently ship
 * (scrubbed) text to a remote host. Non-loopback hosts are therefore refused
 * unless the operator opts in explicitly with `local.ollama.allowRemote: true`
 * — the legitimate case being one Ollama GPU box on the operator's own LAN.
 */
function urlPermitted(url: string, allowRemote: boolean): boolean {
  if (allowRemote) return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Effective config: per-call overrides > settings `local.ollama` > defaults. Settings
 * values are hand-editable JSON, so each is validated and a nonsense value (empty string,
 * negative timeout, wrong type) falls back to the default rather than breaking the client.
 */
export function ollamaConfig(overrides: Partial<OllamaConfig> = {}): OllamaConfig {
  const raw = ollamaSettings();
  const url = settingsString(overrides.url) ?? settingsString(raw.url) ?? DEFAULTS.url;
  const model = settingsString(overrides.model) ?? settingsString(raw.model) ?? DEFAULTS.model;
  const timeoutMs = settingsTimeout(overrides.timeoutMs) ?? settingsTimeout(raw.timeoutMs) ?? DEFAULTS.timeoutMs;
  const allowRemote = raw.allowRemote === true;
  return { url: urlPermitted(url, allowRemote) ? normalizeUrl(url) : DEFAULTS.url, model, timeoutMs };
}

/**
 * Is the local NER pass switched on? Opt-IN (`local.ollama.ner === true`): on a machine with
 * no daemon the flag being off means no caller pays even a cached probe, and turning it on is
 * a deliberate operator act.
 */
export function ollamaNerEnabled(): boolean {
  return ollamaSettings().ner === true;
}

// ---------------------------------------------------------------------------
// availability probe
// ---------------------------------------------------------------------------

/**
 * The body, or `null` if the daemon sent more than MAX_RESPONSE_BYTES. Reading through the
 * stream rather than `.text()`/`.json()` is what makes the cap real: the check happens per
 * chunk, so an oversized answer is abandoned mid-flight instead of being materialised first
 * and measured afterwards. Cancelling releases the socket the same way draining does, and
 * every failure (abort, reset, cancel) lands on the callers' one branch: `null`.
 */
async function readCapped(response: Response): Promise<string | null> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null; // aborted by the deadline, or the daemon dropped the connection mid-body
  }
  return Buffer.concat(chunks).toString("utf8");
}

const availability = new Map<string, { ok: boolean; at: number }>();

/** Drops the cached verdicts. Tests use it; so does a caller that just started the daemon. */
export function resetOllamaCache(): void {
  availability.clear();
}

/**
 * `GET {url}/api/tags` — the cheapest endpoint that proves a daemon is really there (a bare
 * TCP connect would also succeed against anything else listening on that port). Cached per
 * URL for 60s, negative results included.
 */
export async function ollamaAvailable(overrides: Partial<OllamaConfig> = {}): Promise<boolean> {
  const cfg = ollamaConfig(overrides);
  const cached = availability.get(cfg.url);
  if (cached && Date.now() - cached.at < AVAILABILITY_TTL_MS) return cached.ok;

  let ok = false;
  try {
    const response = await fetch(`${cfg.url}/api/tags`, {
      signal: AbortSignal.timeout(Math.min(cfg.timeoutMs, PROBE_TIMEOUT_CAP_MS)),
    });
    ok = response.ok;
    // Drain the body even when it is not wanted: an unconsumed response keeps its socket
    // checked out of the connection pool, which holds the event loop open (a test process
    // that never exits) and leaks a connection per probe in a long-running dashboard.
    // Capped, because a listener that answers /api/tags with a gigabyte is still a listener.
    await readCapped(response);
  } catch {
    ok = false; // not installed / not running / wedged / bad URL — all the same to a caller
  }
  availability.set(cfg.url, { ok, at: Date.now() });
  return ok;
}

// ---------------------------------------------------------------------------
// generation
// ---------------------------------------------------------------------------

/**
 * One non-streaming completion. Returns the model's text, or `null` for EVERY failure mode
 * — connection refused, timeout, non-2xx, unparseable body, missing `response` field. The
 * caller's fallback path is the same in all of them, and a thrown error here would have to
 * be caught at each of the (single-threaded, user-facing) call sites.
 */
export async function ollamaGenerate(prompt: string, overrides: Partial<OllamaConfig> = {}): Promise<string | null> {
  const cfg = ollamaConfig(overrides);
  try {
    const response = await fetch(`${cfg.url}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, prompt, stream: false }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!response.ok) {
      await readCapped(response); // release the socket (see ollamaAvailable)
      return null;
    }
    // Read-then-parse rather than `response.json()`: the cap has to apply to the bytes on the
    // wire, before anything is decoded into a string and a JS object (audit 2026-08-13 M2).
    const raw = await readCapped(response);
    if (raw === null) return null;
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { return null; }
    if (!isRecord(payload) || typeof payload.response !== "string") return null;
    return payload.response;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// NER
// ---------------------------------------------------------------------------

/**
 * Written for a 3B instruct model: one job, an explicit empty case, and a worked example,
 * because small models answer "no names here" in prose unless shown otherwise. The output
 * contract is strict JSON, but `parseNames` assumes it will be violated anyway.
 */
const NER_PROMPT = [
  "You extract person names from text.",
  "Return ONLY a JSON array of the person names that appear in the TEXT below.",
  "Rules: no explanation, no markdown, no keys — just the array.",
  "Copy each name exactly as it is written in the text. Do not invent names.",
  "Ignore places, subjects, organisations, and any ⟨token⟩ placeholder.",
  'If there are no person names, return exactly [].',
  'Example — TEXT: "Riya asked Mr Sharma about the deployment" -> ["Riya","Mr Sharma"]',
].join("\n");

/**
 * Defensive parse of a small model's "JSON". Everything here is a failure actually observed
 * from 3B models: ```json fences, a sentence before the array, single-element strings
 * instead of an array, nulls and numbers inside the array, and paragraphs where a name
 * should be. Anything not confidently a name is dropped, and any doubt about the whole
 * payload yields `[]` — a missed name falls back to the synchronous scrub, while a bogus
 * "name" like "the" would redact half the text.
 */
function parseNames(raw: string): string[] {
  // Strip a fenced block (```json … ```), then keep only the outermost [ … ] span.
  const unfenced = raw.replace(/```[a-zA-Z]*\s*/g, "").replace(/```/g, "");
  const start = unfenced.indexOf("[");
  const end = unfenced.lastIndexOf("]");
  if (start < 0 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry !== "string") continue; // nulls, numbers, nested objects
    const name = entry.trim();
    // A name is short and single-line. The length bound is what stops a model that answered
    // with a sentence ("There are no names in this text") from being treated as a name.
    if (name.length < 2 || name.length > 60 || /[\n\r]/.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= MAX_NAMES) break;
  }
  return names;
}

/**
 * Person names found in `text`, or `[]`. The caller must pass text that has ALREADY cleared
 * the synchronous scrub — this is the deeper pass that catches names no dictionary can know,
 * not a substitute for the dictionary one.
 */
export async function nerNames(text: string, overrides: Partial<OllamaConfig> = {}): Promise<string[]> {
  const subject = text.trim().slice(0, MAX_NER_INPUT);
  if (subject.length === 0) return [];
  const raw = await ollamaGenerate(`${NER_PROMPT}\n\nTEXT:\n${subject}\n\nJSON:`, overrides);
  if (raw === null) return [];
  return parseNames(raw);
}
