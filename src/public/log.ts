import fs from "node:fs";
import path from "node:path";

/**
 * The content-free public request log: one JSON line per request the public surface answers and
 * one per public model turn, at `<dataDir>/logs/public.log`, rotated by size (public.log.1 …
 * public.log.<keep>). It exists so the owner can see load, latency and failures on the public
 * link. It NEVER carries message text, transcripts, replies, audio, IP addresses, cookies or
 * visitor ids: a visitor appears only as a short one-way hash, and a request by its method,
 * path (no query string), status, duration and Cloudflare ray id.
 */

export type PublicLogEntry =
  | { type: "request"; method: string; path: string; status: number; ms: number; visitor?: string; cfRay?: string; tunnelled: boolean }
  | { type: "turn"; mode: string; outcome: "answered" | "fastpath" | "blocked" | "failed" | "busy" | "violation"; ms: number; queueMs?: number; modelMs?: number; firstSentenceMs?: number; provider?: string; chars?: number; reason?: string; visitor?: string; cfRay?: string }
  | { type: "tunnel"; active: boolean; kind: string };

const CF_RAY = /^[0-9a-f]{8,20}(?:-[A-Z]{3})?$/i;

/** A CF-Ray value, only when it looks like one (the edge sets it; anything else is dropped). */
export function cfRayOf(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && CF_RAY.test(value.trim()) ? value.trim() : undefined;
}

export class PublicRequestLog {
  private readonly file: string;
  private bytes = -1;

  constructor(logDir: string, private readonly options: { enabled: boolean; maxBytes?: number; keep?: number } = { enabled: true }) {
    this.file = path.join(logDir, "public.log");
  }

  get path(): string { return this.file; }

  write(entry: PublicLogEntry): void {
    if (!this.options.enabled) return;
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
    try {
      if (this.bytes < 0) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        try { this.bytes = fs.statSync(this.file).size; } catch { this.bytes = 0; }
      }
      if (this.bytes + line.length > (this.options.maxBytes ?? 5 * 1024 * 1024)) this.rotate();
      // Synchronous append of one short line: ordering is kept and nothing is lost on a crash.
      fs.appendFileSync(this.file, line, { mode: 0o600 });
      this.bytes += Buffer.byteLength(line);
    } catch { /* the log is diagnostics only; a full disk must never break the public page */ }
  }

  private rotate(): void {
    const keep = Math.max(1, this.options.keep ?? 3);
    try { fs.rmSync(`${this.file}.${keep}`, { force: true }); } catch { /* best effort */ }
    for (let index = keep - 1; index >= 1; index -= 1) {
      try { fs.renameSync(`${this.file}.${index}`, `${this.file}.${index + 1}`); } catch { /* missing: fine */ }
    }
    try { fs.renameSync(this.file, `${this.file}.1`); } catch { /* missing: fine */ }
    this.bytes = 0;
  }
}
