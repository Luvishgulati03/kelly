import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setActiveProfile } from "../src/profile.ts";
import { HenryRuntime } from "../src/runtime.ts";
import { startDashboard } from "../src/dashboard/server.ts";
import { resetLoginThrottleForTests } from "../src/dashboard/auth.ts";
import { publicModeConfig, type PublicModeConfig } from "../src/public/config.ts";
import type { PublicVoice } from "../src/public/surface.ts";
import type { RunOptions } from "../src/providers/runner.ts";
import type { ProviderEvent, RunResult } from "../src/types.ts";

/**
 * A loopback Kelly dashboard (kelly profile) on a temp data dir with the public surface wired to
 * fakes: a scripted provider runner that records every prompt and option, and a fake voice.
 * `tunnel()` builds headers that make a request look like it came through Cloudflare. Every value
 * here is a placeholder (example.com, a fictional shop).
 */

export const PUBLIC_ORIGIN = "https://kelly.example.com";
export const SHOP_NAME = "Example Electricals";

export function tone(samples = 160, rate = 16000): Buffer {
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 8000), 44 + i * 2);
  return wav;
}

export interface PublicHarness {
  base: string;
  root: string;
  dataDir: string;
  runtime: HenryRuntime;
  runs: Array<{ prompt: string; options: RunOptions }>;
  /** The scripted reply (or a function of the prompt). `events` overrides the event stream. */
  reply: { current: string | ((prompt: string) => string | Promise<string>); events?: ProviderEvent[]; error?: string };
  tts: string[];
  stt: number[];
  sweep(): number;
  close(): Promise<void>;
}

const restore: Array<() => void> = [];
function setEnv(key: string, value: string | undefined): void {
  const previous = process.env[key];
  restore.push(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

export async function publicHarness(options: { trade?: "electrical" | "boutique"; mode?: Partial<PublicModeConfig>; env?: Record<string, string | undefined>; catalogue?: boolean } = {}): Promise<PublicHarness> {
  setActiveProfile("kelly");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-public-e2e-"));
  fs.cpSync(path.join(process.cwd(), "workflows"), path.join(root, "workflows"), { recursive: true });
  const dataDir = path.join(root, "data");
  setEnv("KELLY_DATA_DIR", dataDir);
  setEnv("KELLY_MEMORY_DIR", path.join(root, "memory"));
  setEnv("KELLY_PUBLIC_ORIGIN", PUBLIC_ORIGIN);
  setEnv("KELLY_TRADE", options.trade ?? "electrical");
  setEnv("KELLY_SHOP_NAME", SHOP_NAME);
  setEnv("KELLY_REMOTE_LOGIN", undefined);
  for (const [key, value] of Object.entries(options.env ?? {})) setEnv(key, value);
  resetLoginThrottleForTests();
  const runtime = await HenryRuntime.create(root);
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";
  if (options.catalogue !== false && runtime.commerce) {
    const store = runtime.commerce.store;
    const imported = store.importProducts(path.join(root, "catalogue.csv"), "csv", Buffer.from(`catalogue-${root}`), [
      { sku: "MCB-32A", brand: "Acme", name: "MCB 32A single pole", category: "mcb", unit: "piece", pricePaise: 25_000, gstBasisPoints: 1_800, sourceLocation: "Sheet1!A2" },
      { sku: "SW-6A", brand: "Acme", name: "Switch 6A", category: "switch", unit: "piece", pricePaise: 4_500, gstBasisPoints: 1_800, sourceLocation: "Sheet1!A3" },
      { sku: "WIRE-1.5", brand: "Beta", name: "Wire 1.5 sqmm", category: "wire", unit: "metre", pricePaise: 1_850, gstBasisPoints: 1_800, sourceLocation: "Sheet1!A4" },
    ]);
    store.publish(imported.documentId);
  }
  const runs: PublicHarness["runs"] = [];
  const reply: PublicHarness["reply"] = { current: "The 32A MCB is ₹295.00 including GST." };
  const runner = {
    run: async (prompt: string, runOptions: RunOptions): Promise<RunResult> => {
      runs.push({ prompt, options: runOptions });
      const text = typeof reply.current === "function" ? await reply.current(prompt) : reply.current;
      return {
        runId: `run-${runs.length}`, provider: "codex", response: text, exitCode: 0, durationMs: 1,
        ...(reply.error ? { error: reply.error } : {}),
        events: reply.events ?? [{ timestamp: "", stream: "stdout", text: "", parsed: { type: "item.completed", item: { type: "agent_message", text } } }],
      };
    },
  };
  const tts: string[] = [];
  const stt: number[] = [];
  const voice: PublicVoice = {
    sttEnabled: () => true,
    ttsEnabled: () => true,
    transcribe: async (audio: Buffer) => { stt.push(audio.length); return { text: "What is the rate of a 32 amp MCB?" }; },
    synthesize: async (text: string) => { tts.push(text); return tone(1600); },
  };
  const mode: PublicModeConfig = { ...publicModeConfig("kelly", {}), ...options.mode };
  let sweep: () => number = () => 0;
  const server = startDashboard(runtime, {
    publicSurface: { runner, mode, voice, sweepIntervalMs: 0 },
    onPublicSurface: (surface) => { sweep = () => surface.sweepIdle(); },
  });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    base: `http://127.0.0.1:${address.port}`,
    root, dataDir, runtime, runs, reply, tts, stt,
    sweep: () => sweep(),
    async close() {
      await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
      runtime.close();
      while (restore.length) restore.pop()!();
      resetLoginThrottleForTests();
    },
  };
}

/** Headers that make a request look like it arrived through the Cloudflare tunnel. */
export function tunnel(extra: Record<string, string> = {}, ip = "203.0.113.7"): Record<string, string> {
  return { "cf-connecting-ip": ip, "cf-ray": "8f00000000000000-LHR", "x-forwarded-proto": "https", "x-forwarded-for": ip, ...extra };
}

/** Collects `name=value` pairs from Set-Cookie headers into one Cookie header value. */
export function cookieFrom(response: Response, existing = ""): string {
  const jar = new Map(existing.split(";").map((part) => part.trim()).filter(Boolean).map((part) => [part.split("=")[0], part] as const));
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";")[0];
    jar.set(pair.split("=")[0], pair);
  }
  return [...jar.values()].join("; ");
}

/** Parses an SSE body into [event, data] pairs. */
export async function sse(response: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const text = await response.text();
  return text.split("\n\n").filter(Boolean).map((block) => ({
    event: /^event: (.+)$/m.exec(block)?.[1] ?? "",
    data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? "{}") as Record<string, unknown>,
  }));
}

/** A visitor: loads a page through the tunnel and keeps its cookie. */
export async function visitor(base: string, page = "/explore/chat"): Promise<string> {
  const response = await fetch(`${base}${page}`, { headers: tunnel({ accept: "text/html" }) });
  assert.equal(response.status, 200);
  await response.text();
  return cookieFrom(response);
}

export async function chat(base: string, cookie: string, message: string, mode = "chat", extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/api/public/chat`, {
    method: "POST",
    headers: { ...tunnel(extra), origin: PUBLIC_ORIGIN, cookie, "content-type": "application/json" },
    body: JSON.stringify({ message, mode }),
  });
}
