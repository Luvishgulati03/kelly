import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { HenryConfig } from "../config.ts";
import type { ActivityKind, ProviderName } from "../types.ts";
import type { TradePack } from "../trade/index.ts";
import type { CommerceStore } from "../commerce/store.ts";
import type { DesignRecord } from "../designs/store.ts";
import type { DesignService } from "../designs/rag.ts";
import { galleryFastPath } from "../designs/fastpath.ts";
import { voicePrompt } from "../designs/vocabulary.ts";
import { stripForSpeech } from "../voice/speakable.ts";
import { publicModeConfig, remoteLoginEnabled, type PublicModeConfig } from "./config.ts";
import { publicCatalogueContext } from "./catalogue.ts";
import { buildPublicPrompt, type PublicMode } from "./prompt.ts";
import { guardPublicReply, publicRefusalLine } from "./guard.ts";
import { runPublicModelTurn, type PublicRunner } from "./turn.ts";
import { cfRayOf, PublicRequestLog, type PublicLogEntry } from "./log.ts";
import {
  ConcurrencyGate, RateLimiter, VisitorStore, hashedVisitor, isVisitorId, newVisitorId, readVisitorCookie, visitorCookie,
} from "./visitors.ts";

/**
 * KELLY'S PUBLIC FACE ("Explore Kelly") — everything an UNAUTHENTICATED visitor reaches through
 * the tunnel.
 *
 * The dashboard server (src/dashboard/server.ts, "THE TUNNEL GATE") classifies each request
 * fail-closed (isPublicRequest: any Cloudflare/proxy header, a non-loopback Host, or a
 * non-loopback peer). A tunnelled request may reach only this file's explicit allowlist
 * (PUBLIC_TUNNEL_ROUTES); anything else is a 404 (or a 302 to / for a page). Owner and counter
 * login through the tunnel are off unless KELLY_REMOTE_LOGIN=on. Nothing on this surface reads or
 * writes conversations, voice transcripts, Engram memory, quotes, approvals, usage or settings,
 * and nothing it serves carries anything a customer said: visitors are in-memory only
 * (src/public/visitors.ts) and the public request log is content-free (src/public/log.ts).
 * tests/public-routes.test.ts walks every route the server registers and asserts the tunnel sees
 * only this allowlist.
 *
 * The owner's own browser on 127.0.0.1 may preview the same pages under /explore/* and
 * /api/public/*; every other local path is the owner's dashboard, exactly as before.
 */

/** Every method+path the tunnel may reach. `*` matches exactly one path segment. */
export const PUBLIC_TUNNEL_ROUTES: readonly string[] = Object.freeze([
  "GET /",
  "GET /explore/talk",
  "GET /explore/counter",
  "GET /explore/chat",
  "GET /manifest.webmanifest",
  "GET /icon-192.png",
  "GET /icon-512.png",
  "GET /vendor/vad/*",
  "GET /holo.js",
  "GET /constellation.js",
  "GET /api/health",
  "GET /api/public/config",
  "GET /api/public/heartbeat",
  "GET /api/public/voice/greeting",
  "GET /api/public/voice/reprompt",
  "GET /api/public/voice/filler",
  "POST /api/public/chat",
  "POST /api/public/reset",
  "POST /api/public/voice/transcribe",
  "POST /api/public/voice/speak",
  "GET /api/public/designs/*/image",
  "GET /api/public/designs/*/thumb",
]);

const WILDCARD_ROUTES: Array<{ key: string; pattern: RegExp }> = [
  { key: "GET /vendor/vad/*", pattern: /^\/vendor\/vad\/[^/]+$/ },
  { key: "GET /api/public/designs/*/image", pattern: /^\/api\/public\/designs\/[^/]+\/image$/ },
  { key: "GET /api/public/designs/*/thumb", pattern: /^\/api\/public\/designs\/[^/]+\/thumb$/ },
];

/** The allowlist entry a request matches, or undefined. */
export function matchPublicRoute(method: string | undefined, pathname: string): string | undefined {
  const route = pathname.replace(/\/+$/, "") || "/";
  const key = `${method ?? "GET"} ${route}`;
  if (!key.includes("*") && PUBLIC_TUNNEL_ROUTES.includes(key)) return key;
  if (method !== "GET") return undefined;
  return WILDCARD_ROUTES.find((entry) => entry.pattern.test(route))?.key;
}

/** Paths that belong to the public surface itself (locally too): /explore/* and /api/public/*. */
export function isPublicPath(pathname: string): boolean {
  return pathname === "/explore" || pathname.startsWith("/explore/") || pathname === "/api/public" || pathname.startsWith("/api/public/");
}

const PROXY_HEADERS = ["cf-connecting-ip", "cf-ray", "cf-visitor", "cf-ipcountry", "cf-warp-tag-id", "cdn-loop", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip", "tailscale-user-login", "tailscale-user-name"];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function hostName(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith("[")) return trimmed.slice(0, trimmed.indexOf("]") + 1);
  const colon = trimmed.lastIndexOf(":");
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

function peerIsLoopback(request: http.IncomingMessage): boolean {
  const address = request.socket.remoteAddress || "";
  const bare = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return bare === "::1" || /^127\./.test(bare);
}

/**
 * FAIL-CLOSED classification: is this request (possibly) from the public internet? True when it
 * carries ANY Cloudflare/Tailscale/proxy header (the Cloudflare edge always adds CF-Connecting-IP
 * and CF-Ray, and a visitor cannot remove them), when its Host is not a loopback name, or when its
 * socket peer is not loopback. A request can only be made to look MORE public; the one way to look
 * local is to be the owner's own browser talking to 127.0.0.1. When the operator has explicitly
 * enabled the token-protected remote dashboard (non-loopback bind), the Host and peer checks are
 * skipped; proxy headers still route to the public face.
 */
export function isPublicRequest(request: http.IncomingMessage, options: { allowRemoteDashboard: boolean }): boolean {
  for (const header of PROXY_HEADERS) if (request.headers[header] !== undefined) return true;
  if (options.allowRemoteDashboard) return false;
  const host = request.headers.host;
  if (typeof host !== "string" || !LOOPBACK_HOSTS.has(hostName(host))) return true;
  return !peerIsLoopback(request);
}

/** Parses `value` as an https origin (`https://host[:port]`), or undefined. Exact-match material only. */
export function normalizeHttpsOrigin(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value.includes("://") ? value : `https://${value}`);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return undefined;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}

/**
 * The https origins the public face (and a remote owner session) trusts: KELLY_PUBLIC_ORIGIN,
 * https://<KELLY_PUBLIC_HOST>, and the live tunnel's reported URL. Exact string matches only.
 */
export function trustedPublicOrigins(tunnelUrl: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const origins = [
    normalizeHttpsOrigin(env.KELLY_PUBLIC_ORIGIN), normalizeHttpsOrigin(env.KELLY_PUBLIC_HOST),
    normalizeHttpsOrigin(env.HENRY_PUBLIC_ORIGIN), normalizeHttpsOrigin(env.HENRY_PUBLIC_HOST),
    normalizeHttpsOrigin(tunnelUrl),
  ].filter((origin): origin is string => Boolean(origin));
  return [...new Set(origins)];
}

const LOOPBACK_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/** A valid CF-Connecting-IP value (the edge sets it; it is only ever used as a rate-limit key). */
function cloudflareClientIp(request: http.IncomingMessage): string | undefined {
  const value = request.headers["cf-connecting-ip"];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[0-9A-Fa-f:.]{3,45}$/.test(trimmed) ? trimmed : undefined;
}

/* ---------------------------------------------------------------- *
 * Visitor-facing lines (nothing personal).
 * ---------------------------------------------------------------- */

export const PUBLIC_LINES = Object.freeze({
  busy: "I'm helping a few customers at once right now. Please give me a minute, then ask again.",
  rate: "You're quick! Give me a few seconds, then ask again.",
  oneAtATime: "Still answering your last question. One moment.",
  failed: "Sorry, I couldn't answer that just now. Please try again in a moment.",
  tooLong: (max: number) => `That's a lot for one message. Could you keep it under ${max} characters?`,
  empty: "Ask me about an item, a price, or a design.",
});

const SAMPLE_PROMPTS: Record<string, { talk: string[]; counter: string[]; chat: string[] }> = {
  electrical: {
    talk: ["What is the rate of a 32 amp MCB?", "Mujhe dus LED bulb chahiye, kitna hoga?"],
    counter: ["I need 20 metres of 1.5 sqmm wire.", "Which brands of ceiling fan do you have?"],
    chat: ["Quote 5 x 6A switch and 2 x 16A socket", "Pankhe ka rate kya hai?", "What does GST add to a 32A MCB?"],
  },
  boutique: {
    talk: ["Show me bridal lehenga designs.", "Blouse silwane ka rate kya hai?"],
    counter: ["How much for a suit with lining?", "Show me the latest saree designs."],
    chat: ["Rate for 2 blouses with embroidery", "Show me trending kurti designs", "Lehenga stitching kitne ka hai?"],
  },
};

/* ---------------------------------------------------------------- *
 * The surface.
 * ---------------------------------------------------------------- */

export interface PublicVoice {
  sttEnabled(): boolean;
  ttsEnabled(): boolean;
  transcribe(audio: Buffer, options?: { language?: "auto" | "hi" | "en" | "hi-en"; prompt?: string }): Promise<{ text: string; language?: string }>;
  synthesize(text: string, options?: { language?: "auto" | "hi" | "en" | "hi-en" }): Promise<Buffer>;
}

export interface PublicSurfaceDeps {
  config: Pick<HenryConfig, "profileId" | "dataDir" | "shopName" | "dashboardToken" | "telegramBotToken" | "telegramChatId">;
  trade: TradePack;
  activity: { record(kind: ActivityKind, message: string, metadata?: Record<string, unknown>): Promise<unknown> };
  runner: PublicRunner;
  voice: PublicVoice;
  /** Cached synthesis of a fixed phrase (the dashboard's prompt cache). */
  synthesizeCached: (text: string) => Promise<Buffer>;
  /** The published catalogue / rate card (read-only), when this install has one. */
  commerceStore: () => CommerceStore | undefined;
  /** The design gallery (read-only use), when the trade has one. */
  designs: () => DesignService | undefined;
  vendorAsset: (name: string) => Promise<{ bytes: Buffer; contentType: string } | null>;
  /** holo.js / constellation.js: static visual scripts with no data in them. */
  staticScript: (name: "holo.js" | "constellation.js") => Promise<string>;
  icon: (size: 192 | 512) => Buffer;
  /** Writes GET /api/health exactly as the local dashboard does. */
  health: (request: http.IncomingMessage, response: http.ServerResponse) => void;
  /** The live tunnel's public URL, when it reports one. */
  tunnelUrl: () => string | undefined;
  /** Whether the brain (the configured CLI) is currently usable, from the limit ledger only. */
  brainReady: () => boolean;
  provider?: ProviderName;
  mode?: PublicModeConfig;
  log?: PublicRequestLog;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** Idle sweep period; 0 disables the timer (tests call sweepIdle()). */
  sweepIntervalMs?: number;
}

const PAGE_FILES = {
  landing: fileURLToPath(new URL("../dashboard/explore.html", import.meta.url)),
  talk: fileURLToPath(new URL("../dashboard/explore-talk.html", import.meta.url)),
  counter: fileURLToPath(new URL("../dashboard/explore-counter.html", import.meta.url)),
  chat: fileURLToPath(new URL("../dashboard/explore-chat.html", import.meta.url)),
};
type PageName = keyof typeof PAGE_FILES;

/** Served only when src/dashboard/explore.html is missing: a plain page, nothing personal in it. */
export const EXPLORE_FALLBACK_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Explore Kelly</title>`
  + `<link rel="manifest" href="/manifest.webmanifest"><style>body{font-family:system-ui,sans-serif;background:#141516;color:#eee;max-width:34rem;margin:4rem auto;padding:0 1.2rem;line-height:1.55}a{display:block;margin:.6rem 0;padding:.9rem 1rem;border:1px solid #333;border-radius:12px;color:#f0b072;text-decoration:none}p{color:#aaa}</style></head>`
  + `<body><h1>Explore Kelly</h1><p>Kelly is a local-first voice counter assistant for small shops. Try a conversation:</p>`
  + `<a href="/explore/talk">Talk: hands-free voice</a><a href="/explore/counter">Counter: tap to talk</a><a href="/explore/chat">Chat: type a message</a></body></html>`;

const pageCache = new Map<string, string>();
async function readPage(name: PageName): Promise<string | undefined> {
  const cached = pageCache.get(name);
  if (cached) return cached;
  try {
    const html = await fs.readFile(PAGE_FILES[name], "utf8");
    // explore.html is written separately; it is re-read until present, then cached.
    pageCache.set(name, html);
    return html;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** jsDelivr hosts the pinned Silero VAD / onnxruntime-web assets so they never cross the tunnel. */
export const VAD_CDN_ORIGIN = "https://cdn.jsdelivr.net";

export const PUBLIC_CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: ${VAD_CDN_ORIGIN}`,
  // The Explore landing page uses Google Fonts; nothing else third-party is allowed.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  `connect-src 'self' ${VAD_CDN_ORIGIN}`,
  `worker-src 'self' blob: ${VAD_CDN_ORIGIN}`,
  "font-src 'self' data: https://fonts.gstatic.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

function securityHeaders(extra: http.OutgoingHttpHeaders = {}): http.OutgoingHttpHeaders {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    ...extra,
  };
}

function sendJson(response: http.ServerResponse, status: number, value: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  response.writeHead(status, securityHeaders({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }));
  response.end(JSON.stringify(value));
}

async function readBody(request: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += piece.length;
    if (total > limit) throw Object.assign(new Error("too large"), { code: "too_large" });
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: http.IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const raw = (await readBody(request, limit)).toString("utf8");
  const parsed: unknown = JSON.parse(raw || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be a JSON object");
  return parsed as Record<string, unknown>;
}

/** Seconds of audio in a PCM WAV, or undefined when the header is unreadable. */
export function wavSeconds(audio: Buffer): number | undefined {
  try {
    let offset = 12; let byteRate = 0; let dataLength = 0;
    while (offset + 8 <= audio.length) {
      const name = audio.toString("ascii", offset, offset + 4);
      const size = audio.readUInt32LE(offset + 4);
      if (name === "fmt " && size >= 16) byteRate = audio.readUInt32LE(offset + 16);
      if (name === "data") { dataLength = Math.min(size, audio.length - offset - 8); break; }
      offset += 8 + size + (size & 1);
    }
    return byteRate > 0 && dataLength > 0 ? dataLength / byteRate : undefined;
  } catch { return undefined; }
}

/**
 * Sentences of a reply for streaming and speech. Unlike a naive split on ".", a decimal point or a
 * thousands separator inside an amount ("₹1,234.50") never ends a sentence.
 */
export function publicSentences(text: string): string[] {
  const out: string[] = [];
  let current = "";
  const chars = [...text.trim()];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    current += char;
    if (/[.?!।\n]/.test(char)) {
      const next = chars[index + 1];
      const prev = chars[index - 1];
      const decimal = char === "." && prev !== undefined && /\d/.test(prev) && next !== undefined && /\d/.test(next);
      if (!decimal && (next === undefined || /\s/.test(next))) {
        if (current.trim()) out.push(current.trim());
        current = "";
      }
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

const DESIGN_ID = /^dsg_[0-9a-f]{16}$/;

function designItem(design: DesignRecord): { id: string; title: string; price: string; imageUrl: string } {
  return {
    id: design.id,
    title: design.caption || design.category,
    price: design.priceBand || "",
    imageUrl: `/api/public/designs/${design.id}/image`,
  };
}

function isMode(value: unknown): value is PublicMode {
  return value === "talk" || value === "counter" || value === "chat";
}

export interface PublicSurface {
  /** Serves a public request. Always responds when `tunnelled`; otherwise returns false for non-public paths. */
  handle(request: http.IncomingMessage, response: http.ServerResponse, url: URL, tunnelled: boolean): Promise<boolean>;
  /** Forgets idle visitors. Returns how many were dropped. */
  sweepIdle(): number;
  close(): void;
  readonly visitors: VisitorStore;
  readonly mode: PublicModeConfig;
}

export function createPublicSurface(deps: PublicSurfaceDeps): PublicSurface {
  const env = deps.env ?? process.env;
  const mode = deps.mode ?? publicModeConfig(deps.config.profileId, env);
  const now = deps.now ?? Date.now;
  const started = now();
  const shopName = mode.shopName || deps.config.shopName;
  const pack = deps.trade;
  const phraseText = (template: string): string => template.replaceAll("<shop>", shopName);
  const greeting = phraseText(pack.greeting);
  const reprompt = phraseText(pack.reprompt);
  const fillers = pack.fillers.length ? pack.fillers.map(phraseText) : ["One moment."];
  const visitors = new VisitorStore({ maxHistoryTurns: mode.maxHistoryTurns, idleMs: mode.idleMs, maxVisitors: mode.maxVisitors }, now);
  const visitorLimiter = new RateLimiter([{ ms: 60_000, max: mode.perVisitorPerMinute }, { ms: 3_600_000, max: mode.perVisitorPerHour }], now);
  const clientLimiter = new RateLimiter([{ ms: 60_000, max: mode.perClientPerMinute }, { ms: 3_600_000, max: mode.perClientPerHour }], now);
  const audioLimiter = new RateLimiter([{ ms: 60_000, max: mode.perClientPerMinute * 3 }, { ms: 3_600_000, max: mode.perClientPerHour * 3 }], now);
  const gate = new ConcurrencyGate(mode.maxConcurrent, mode.maxQueue);
  const log = deps.log;
  const blockedValues = [deps.config.telegramBotToken, deps.config.telegramChatId, deps.config.dashboardToken, env.KELLY_DASH_SECRET, env.KELLY_KOKORO_TOKEN, env.HENRY_DASH_SECRET, env.HENRY_KOKORO_TOKEN];
  let sttBusy = 0;
  let ttsBusy = 0;
  let lastReplyMs: number | null = null;

  /** Content-free activity: counters and reasons only, never what anyone said. */
  const record = (kind: ActivityKind, message: string, metadata: Record<string, unknown> = {}): void => {
    void deps.activity.record(kind, message, { public: true, ...metadata }).catch(() => undefined);
  };

  const clientKey = (request: http.IncomingMessage, tunnelled: boolean): string => {
    // CF-Connecting-IP only when the request came through the tunnel, and only for rate limits.
    const ip = tunnelled ? cloudflareClientIp(request) : undefined;
    return ip ? `cf:${ip}` : `peer:${request.socket.remoteAddress ?? "unknown"}`;
  };

  const originOk = (request: http.IncomingMessage, tunnelled: boolean): boolean => {
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !origin) return false;
    const trusted = trustedPublicOrigins(deps.tunnelUrl(), env);
    if (tunnelled) return trusted.includes(origin);
    return LOOPBACK_ORIGIN_RE.test(origin) || trusted.includes(origin);
  };

  /** The visitor id from the cookie, minting (and setting) a new one when absent. */
  const visitorIdFor = (request: http.IncomingMessage, response: http.ServerResponse, tunnelled: boolean): string => {
    const existing = readVisitorCookie(request.headers.cookie);
    if (existing) return existing;
    const id = newVisitorId();
    response.setHeader("set-cookie", visitorCookie(id, tunnelled));
    return id;
  };

  const sweepIdle = (): number => visitors.sweepIdle();
  const sweepMs = deps.sweepIntervalMs ?? 60_000;
  const sweepTimer = sweepMs > 0 ? setInterval(() => { sweepIdle(); }, sweepMs) : undefined;
  sweepTimer?.unref?.();

  const brandPage = (html: string): string => {
    const accent = `:root { --copper:${pack.accent.copper}; --copper2:${pack.accent.copper2}; }`;
    const escape = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    return html
      .replaceAll("<!--KELLY_SHOP-->", escape(shopName))
      .replace("<!--KELLY_MARK-->", escape((shopName.trim()[0] || "K").toUpperCase()))
      .replace("<!--KELLY_ACCENT-->", accent)
      .replaceAll("<!--KELLY_THEME_COLOR-->", escape(pack.accent.copper));
  };

  const servePage = async (response: http.ServerResponse, name: PageName): Promise<void> => {
    const raw = await readPage(name);
    const html = raw === undefined ? (name === "landing" ? EXPLORE_FALLBACK_HTML : undefined) : name === "landing" ? raw : brandPage(raw);
    if (html === undefined) { sendJson(response, 404, { error: "not found" }); return; }
    const voicePage = name === "talk" || name === "counter";
    response.writeHead(200, securityHeaders({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": PUBLIC_CSP,
      "permissions-policy": voicePage ? "microphone=(self), camera=(), geolocation=()" : "microphone=(), camera=(), geolocation=()",
    }));
    response.end(html);
  };

  const logTurn = (entry: Omit<Extract<PublicLogEntry, { type: "turn" }>, "type">): void => { log?.write({ type: "turn", ...entry }); };

  /* ---------------- POST /api/public/chat ---------------- */
  const chat = async (request: http.IncomingMessage, response: http.ServerResponse, tunnelled: boolean, visitorId: string): Promise<void> => {
    const turnStarted = now();
    let input: Record<string, unknown>;
    try { input = await readJson(request, 16_384); } catch { sendJson(response, 400, { error: "Send a JSON body with a message." }); return; }
    const message = typeof input.message === "string" ? input.message.trim() : "";
    const chatMode: PublicMode = isMode(input.mode) ? input.mode : "chat";
    if (input.mode !== undefined && !isMode(input.mode)) { sendJson(response, 400, { error: 'mode must be "talk", "counter" or "chat".' }); return; }
    if (!message) { sendJson(response, 400, { error: PUBLIC_LINES.empty }); return; }
    if (message.length > mode.maxMessageChars) { sendJson(response, 413, { error: PUBLIC_LINES.tooLong(mode.maxMessageChars) }); return; }
    if (visitors.get(visitorId)?.busy) { sendJson(response, 429, { error: PUBLIC_LINES.oneAtATime }); return; }
    if (!clientLimiter.take(clientKey(request, tunnelled)) || !visitorLimiter.take(visitorId)) {
      logTurn({ mode: chatMode, outcome: "busy", ms: 0, reason: "rate", visitor: hashedVisitor(visitorId), cfRay: cfRayOf(request.headers["cf-ray"]) });
      sendJson(response, 429, { error: PUBLIC_LINES.rate });
      return;
    }
    // Claimed synchronously (no await since the check above), so two racing requests from one
    // visitor can never both start a model turn.
    const { visitor } = visitors.ensure(visitorId);
    if (visitor.busy) { sendJson(response, 429, { error: PUBLIC_LINES.oneAtATime }); return; }
    visitor.busy = true;
    const voiceMode = chatMode !== "chat";
    const ray = cfRayOf(request.headers["cf-ray"]);
    const hashed = hashedVisitor(visitorId);

    response.writeHead(200, securityHeaders({ "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" }));
    const write = (event: string, data: unknown): void => { if (!response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    /** Records the exchange, then streams it sentence by sentence (each already guarded). */
    const deliver = (text: string, designs?: DesignRecord[]): string => {
      const replyId = crypto.randomBytes(9).toString("base64url");
      visitors.recordExchange(visitor, message, text, replyId);
      if (designs?.length) write("designs", { items: designs.slice(0, 8).map(designItem) });
      const sentences = publicSentences(text);
      (sentences.length ? sentences : [text]).forEach((sentence, part) => write("token", { text: part === 0 ? sentence : ` ${sentence}`, replyId, part }));
      write("done", { response: text, replyId });
      return replyId;
    };
    let release: (() => void) | null = null;
    let queueMs = 0;
    try {
      write("status", { state: "thinking" });
      // A plain gallery browse ask ("show me bridal lehengas") has a complete answer in the local
      // design store: no model, no guard needed beyond the fixed sentence the fast path builds.
      const gallery = pack.galleryCategories.length ? deps.designs() : undefined;
      const fast = gallery ? await galleryFastPath(message, pack, gallery, { markShown: false }).catch(() => undefined) : undefined;
      if (fast) {
        deliver(fast.text, fast.designs);
        lastReplyMs = now() - turnStarted;
        logTurn({ mode: chatMode, outcome: "fastpath", ms: lastReplyMs, chars: fast.text.length, visitor: hashed, cfRay: ray });
        return;
      }
      const previousVisitorMessage = [...visitor.history].reverse().find((entry) => entry.role === "visitor")?.text;
      const catalogue = publicCatalogueContext(deps.commerceStore(), pack, message, previousVisitorMessage);
      if (voiceMode && catalogue.lookup) write("gathering", { reason: "request" });
      const queuedAt = now();
      release = await gate.acquire(mode.queueWaitMs, () => {
        write("status", { state: "queued" });
        if (voiceMode && !catalogue.lookup) write("gathering", { reason: "request" });
      });
      queueMs = now() - queuedAt;
      if (!release) {
        logTurn({ mode: chatMode, outcome: "busy", ms: now() - turnStarted, queueMs, reason: "slots", visitor: hashed, cfRay: ray });
        write("error", { message: PUBLIC_LINES.busy, busy: true });
        return;
      }
      write("status", { state: "answering" });
      const prompt = buildPublicPrompt({ shopName, pack, mode: chatMode, catalogue: catalogue.block, history: visitor.history, message });
      const turn = await runPublicModelTurn(deps.runner, { tier: mode.tier, turnTimeoutMs: mode.turnTimeoutMs, ...(deps.provider ? { provider: deps.provider } : {}) }, prompt);
      if (turn.error || !turn.reply) {
        const violation = Boolean(turn.error?.startsWith("public sandbox violation"));
        logTurn({ mode: chatMode, outcome: violation ? "violation" : "failed", ms: now() - turnStarted, queueMs, modelMs: turn.durationMs, provider: turn.provider, reason: violation ? "sandbox" : turn.limited ? "limited" : "error", visitor: hashed, cfRay: ray });
        record("workflow.failed", violation ? "Public turn discarded by the sandbox check" : "Public turn failed", { provider: turn.provider, durationMs: turn.durationMs, limited: turn.limited === true, violation });
        write("error", { message: PUBLIC_LINES.failed });
        return;
      }
      // Guard every sentence and the whole: one failing sentence replaces the entire reply.
      const whole = guardPublicReply(turn.reply, blockedValues);
      const failing = whole.ok ? publicSentences(turn.reply).map((sentence) => guardPublicReply(sentence, blockedValues)).find((result) => !result.ok) : whole;
      const text = failing ? publicRefusalLine() : whole.text;
      deliver(voiceMode ? stripForSpeech(text) || text : text);
      lastReplyMs = now() - turnStarted;
      logTurn({ mode: chatMode, outcome: failing ? "blocked" : "answered", ms: lastReplyMs, queueMs, modelMs: turn.durationMs, provider: turn.provider, chars: text.length, ...(failing?.reason ? { reason: failing.reason } : {}), visitor: hashed, cfRay: ray });
      if (failing) record("workflow.failed", "Public reply blocked by the output guard", { reason: failing.reason });
    } catch (error) {
      logTurn({ mode: chatMode, outcome: "failed", ms: now() - turnStarted, queueMs, reason: "exception", visitor: hashed, cfRay: ray });
      record("workflow.failed", "Public turn threw", { error: (error instanceof Error ? error.name : "error") });
      write("error", { message: PUBLIC_LINES.failed });
    } finally {
      release?.();
      visitor.busy = false;
      visitor.lastSeen = now();
      response.end();
    }
  };

  /* ---------------- voice ---------------- */
  const transcribe = async (request: http.IncomingMessage, response: http.ServerResponse, tunnelled: boolean): Promise<void> => {
    if (!deps.voice.sttEnabled()) { sendJson(response, 503, { error: "Voice isn't available right now. You can type instead." }); return; }
    const mime = (request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (mime !== "audio/wav" && mime !== "audio/x-wav") { sendJson(response, 415, { error: "Send audio/wav." }); return; }
    const declared = Number(request.headers["content-length"] || 0);
    if (declared > mode.maxAudioBytes) { sendJson(response, 413, { error: "That recording is too long. Try a shorter question." }); return; }
    if (!audioLimiter.take(clientKey(request, tunnelled))) { sendJson(response, 429, { error: PUBLIC_LINES.rate }); return; }
    if (sttBusy >= mode.maxConcurrent) { sendJson(response, 429, { error: "I'm listening to someone else for a second. Try again." }); return; }
    sttBusy += 1;
    try {
      let audio: Buffer;
      try { audio = await readBody(request, mode.maxAudioBytes); } catch { sendJson(response, 413, { error: "That recording is too long. Try a shorter question." }); return; }
      if (audio.length < 44 || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") { sendJson(response, 400, { error: "Audio must be a WAV file." }); return; }
      const seconds = wavSeconds(audio);
      if (seconds === undefined) { sendJson(response, 400, { error: "Audio must be a PCM WAV file." }); return; }
      if (seconds > mode.maxAudioSeconds) { sendJson(response, 413, { error: "That recording is too long. Try a shorter question." }); return; }
      // Nothing is stored: no transcript row, no audio file, no activity text. The words reach
      // Kelly only when the page sends them as the next chat message.
      const result = await deps.voice.transcribe(audio, { language: "auto", prompt: voicePrompt(shopName, pack.vocabulary) });
      sendJson(response, 200, { text: result.text.trim().slice(0, mode.maxMessageChars) });
    } catch {
      if (!response.headersSent) sendJson(response, 503, { error: "I didn't catch that. Could you try again?" });
    } finally { sttBusy -= 1; }
  };

  const speak = async (request: http.IncomingMessage, response: http.ServerResponse, tunnelled: boolean, visitorId: string): Promise<void> => {
    if (!deps.voice.ttsEnabled()) { sendJson(response, 503, { error: "Speech is unavailable." }); return; }
    let input: Record<string, unknown>;
    try { input = await readJson(request, 2_048); } catch { sendJson(response, 400, { error: "Send a JSON body." }); return; }
    // Only a reply Kelly actually gave THIS visitor can be spoken: the endpoint is not a
    // general text-to-speech service.
    const replyId = typeof input.replyId === "string" ? input.replyId : "";
    const text = visitors.get(visitorId)?.replies.get(replyId);
    if (!text) { sendJson(response, 404, { error: "Nothing to say." }); return; }
    const sentences = publicSentences(stripForSpeech(text) || text);
    const part = input.part === undefined ? undefined : Number(input.part);
    if (part !== undefined && (!Number.isInteger(part) || part < 0 || part >= sentences.length)) { sendJson(response, 404, { error: "Nothing to say." }); return; }
    if (!audioLimiter.take(clientKey(request, tunnelled))) { sendJson(response, 429, { error: PUBLIC_LINES.rate }); return; }
    if (ttsBusy >= mode.maxConcurrent + 1) { sendJson(response, 429, { error: "One moment." }); return; }
    ttsBusy += 1;
    try {
      if (part !== undefined) {
        const audio = await deps.voice.synthesize(sentences[part], { language: "en" });
        response.writeHead(200, securityHeaders({ "content-type": "audio/wav", "content-length": audio.length, "cache-control": "no-store" }));
        response.end(audio);
        return;
      }
      // Chunked: each sentence is synthesised and written as soon as it is ready (4-byte
      // big-endian length + a complete WAV), so playback starts after the first sentence.
      response.writeHead(200, securityHeaders({ "content-type": "application/x-kelly-wav-seq", "cache-control": "no-store" }));
      for (const piece of sentences.length ? sentences : [text]) {
        if (response.destroyed) break;
        const audio = await deps.voice.synthesize(piece, { language: "en" });
        const prefix = Buffer.alloc(4);
        prefix.writeUInt32BE(audio.length, 0);
        response.write(prefix);
        response.write(audio);
      }
      response.end();
    } catch {
      if (response.headersSent) { if (!response.writableEnded) response.end(); }
      else sendJson(response, 503, { error: "Speech is unavailable." });
    } finally { ttsBusy -= 1; }
  };

  const phrase = async (response: http.ServerResponse, text: string): Promise<void> => {
    if (!deps.voice.ttsEnabled()) { sendJson(response, 404, { error: "Speech is unavailable." }); return; }
    try {
      const audio = await deps.synthesizeCached(text);
      response.writeHead(200, securityHeaders({ "content-type": "audio/wav", "content-length": audio.length, "cache-control": "private, max-age=3600" }));
      response.end(audio);
    } catch {
      sendJson(response, 503, { error: "Speech is unavailable." });
    }
  };

  const designImage = async (response: http.ServerResponse, rawId: string): Promise<void> => {
    let id = "";
    try { id = decodeURIComponent(rawId); } catch { /* not an id */ }
    const service = pack.galleryCategories.length && DESIGN_ID.test(id) ? deps.designs() : undefined;
    const record = service?.store.get(id);
    const filePath = record && record.status === "active" ? service!.store.imagePath(record.id) : undefined;
    const bytes = filePath ? await fs.readFile(filePath).catch(() => undefined) : undefined;
    if (!record || !bytes) { sendJson(response, 404, { error: "not found" }); return; }
    const mime = record.ext === "jpg" ? "image/jpeg" : record.ext === "png" ? "image/png" : record.ext === "webp" ? "image/webp" : "image/gif";
    response.writeHead(200, securityHeaders({ "content-type": mime, "content-length": bytes.length, "cache-control": "public, max-age=3600", "content-security-policy": "default-src 'none'; sandbox" }));
    response.end(bytes);
  };

  const designCount = (): number => {
    if (!pack.galleryCategories.length) return 0;
    try {
      const stats = deps.designs()?.store.stats();
      return stats ? Math.max(0, stats.total - stats.hidden) : 0;
    } catch { return 0; }
  };

  const route = async (request: http.IncomingMessage, response: http.ServerResponse, url: URL, tunnelled: boolean, key: string): Promise<void> => {
    if (key === "GET /api/health") { deps.health(request, response); return; }
    if (key === "GET /vendor/vad/*") {
      let name = "";
      try { name = decodeURIComponent(url.pathname.slice("/vendor/vad/".length).replace(/\/+$/, "")); } catch { /* not on the allowlist */ }
      const asset = name ? await deps.vendorAsset(name) : null;
      if (!asset) { sendJson(response, 404, { error: "not found" }); return; }
      response.writeHead(200, securityHeaders({ "content-type": asset.contentType, "content-length": asset.bytes.length, "cache-control": "public, max-age=31536000, immutable", "cross-origin-resource-policy": "same-origin" }));
      response.end(asset.bytes);
      return;
    }
    if (key === "GET /holo.js" || key === "GET /constellation.js") {
      const script = await deps.staticScript(key === "GET /holo.js" ? "holo.js" : "constellation.js");
      response.writeHead(200, securityHeaders({ "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=3600" }));
      response.end(script);
      return;
    }
    if (key === "GET /manifest.webmanifest") {
      response.writeHead(200, securityHeaders({ "content-type": "application/manifest+json; charset=utf-8", "cache-control": "public, max-age=3600" }));
      response.end(JSON.stringify({
        name: `${shopName} · Kelly`, short_name: shopName.length > 12 ? shopName.slice(0, 12) : shopName,
        display: "standalone", start_url: "/", scope: "/", background_color: "#141516", theme_color: pack.accent.copper,
        icons: [192, 512].map((size) => ({ src: `/icon-${size}.png`, sizes: `${size}x${size}`, type: "image/png" })),
      }));
      return;
    }
    if (key === "GET /icon-192.png" || key === "GET /icon-512.png") {
      response.writeHead(200, securityHeaders({ "content-type": "image/png", "cache-control": "public, max-age=86400" }));
      response.end(deps.icon(key === "GET /icon-192.png" ? 192 : 512));
      return;
    }
    if (key === "GET /" || key === "GET /explore/talk" || key === "GET /explore/counter" || key === "GET /explore/chat") {
      // The cookie is set with the page, so the first API call already carries it.
      visitorIdFor(request, response, tunnelled);
      await servePage(response, key === "GET /" ? "landing" : key === "GET /explore/talk" ? "talk" : key === "GET /explore/counter" ? "counter" : "chat");
      return;
    }
    if (key === "GET /api/public/config") {
      sendJson(response, 200, {
        shopName,
        trade: pack.id,
        tradeName: pack.displayName,
        accent: pack.accent.copper,
        accentSoft: pack.accent.copper2,
        greeting,
        maxMessageChars: mode.maxMessageChars,
        voice: { stt: deps.voice.sttEnabled(), tts: deps.voice.ttsEnabled() },
        samplePrompts: SAMPLE_PROMPTS[pack.id] ?? SAMPLE_PROMPTS.electrical,
        remoteLogin: remoteLoginEnabled(deps.config.profileId, env),
      });
      return;
    }
    if (key === "GET /api/public/heartbeat") {
      let ready = false;
      try { ready = deps.brainReady(); } catch { ready = false; }
      sendJson(response, 200, {
        online: true,
        uptimeSeconds: Math.max(0, Math.round((now() - started) / 1000)),
        serverTime: new Date(now()).toISOString(),
        voice: { stt: deps.voice.sttEnabled(), tts: deps.voice.ttsEnabled() },
        brain: { ready, lastReplyMs },
        catalogue: { designs: designCount() },
        visitorsNow: visitors.activeWithin(5 * 60_000),
      });
      return;
    }
    if (key === "GET /api/public/voice/greeting") { await phrase(response, greeting); return; }
    if (key === "GET /api/public/voice/reprompt") { await phrase(response, reprompt); return; }
    if (key === "GET /api/public/voice/filler") {
      const variant = Math.max(0, Math.min(99, Number.parseInt(url.searchParams.get("v") ?? "0", 10) || 0));
      await phrase(response, fillers[variant % fillers.length]);
      return;
    }
    if (key === "GET /api/public/designs/*/image" || key === "GET /api/public/designs/*/thumb") {
      await designImage(response, url.pathname.split("/")[4] ?? "");
      return;
    }
    // Every POST: exact trusted origin (loopback too for the owner's local preview) and a cookie.
    if (!originOk(request, tunnelled)) { sendJson(response, 403, { error: "cross-origin request rejected" }); return; }
    const cookieId = readVisitorCookie(request.headers.cookie);
    const visitorId = isVisitorId(cookieId) ? cookieId : visitorIdFor(request, response, tunnelled);
    if (key === "POST /api/public/chat") { await chat(request, response, tunnelled, visitorId); return; }
    if (key === "POST /api/public/reset") {
      const visitor = visitors.get(visitorId);
      if (visitor && !visitor.busy) visitors.resetConversation(visitor);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (key === "POST /api/public/voice/transcribe") { await transcribe(request, response, tunnelled); return; }
    if (key === "POST /api/public/voice/speak") { await speak(request, response, tunnelled, visitorId); return; }
    sendJson(response, 404, { error: "not found" });
  };

  const handle = async (request: http.IncomingMessage, response: http.ServerResponse, url: URL, tunnelled: boolean): Promise<boolean> => {
    const key = matchPublicRoute(request.method, url.pathname);
    if (!tunnelled) {
      // Local: only /explore/* and /api/public/* belong to this surface; "/", /api/health,
      // /manifest.webmanifest, icons, /vendor/vad/* and the scripts stay the owner's dashboard routes.
      if (!isPublicPath(url.pathname)) return false;
    }
    const startedAt = now();
    response.once("finish", () => {
      log?.write({
        type: "request", method: request.method ?? "GET", path: url.pathname.slice(0, 120), status: response.statusCode, ms: now() - startedAt,
        visitor: hashedVisitor(readVisitorCookie(request.headers.cookie)), cfRay: cfRayOf(request.headers["cf-ray"]), tunnelled,
      });
    });
    if (!key || (!tunnelled && key === "GET /")) { sendJson(response, 404, { error: "not found" }); return true; }
    try {
      await route(request, response, url, tunnelled, key);
    } catch {
      if (response.headersSent) { if (!response.writableEnded) response.end(); }
      else sendJson(response, 500, { error: PUBLIC_LINES.failed });
    }
    return true;
  };

  return {
    handle,
    sweepIdle,
    close() {
      if (sweepTimer) clearInterval(sweepTimer);
      visitors.clear();
    },
    visitors,
    mode,
  };
}
