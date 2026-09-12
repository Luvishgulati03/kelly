import { execFile } from "node:child_process";
import { safeEnvironment } from "../util/env.ts";
import type { ProviderName } from "../types.ts";

/**
 * Admission control for provider subprocesses (MASTER_PLAN §7).
 *
 * The M1 Air budget is ~5GB for the whole agent stack, so we never let more
 * than two provider CLIs run at once and never more than one "heavy" CLI
 * (Claude). Before granting a slot we sample macOS memory pressure; a critical
 * reading refuses the spawn outright and a warning reading collapses the pool
 * to a single worker.
 *
 * The policy is pure and testable: the pressure sampler is injected, so unit
 * tests never exec anything.
 */

export type MemoryPressureLevel = "ok" | "warn" | "critical";
export type MemoryPressureSampler = () => Promise<MemoryPressureLevel>;

export interface AdmissionControllerOptions {
  /** Hard ceiling on concurrent provider subprocesses. */
  maxConcurrent?: number;
  /** Ceiling on concurrent heavy (Claude CLI) subprocesses. */
  maxHeavy?: number;
  /** Injected for tests; defaults to the macOS `memory_pressure -Q` sampler. */
  samplePressure?: MemoryPressureSampler;
  /** How long a pressure sample stays fresh (exec is not free). */
  pressureTtlMs?: number;
}

export interface SlotRequest {
  provider?: ProviderName;
  /** Defaults to `provider === "claude"` — the heavier CLI. */
  heavy?: boolean;
  /** Give up waiting after this long (default 300s, matching the envelope). */
  timeoutMs?: number;
  label?: string;
}

export interface AdmissionSlot {
  readonly id: number;
  readonly heavy: boolean;
  /** Idempotent; safe to call from a `finally`. */
  release(): void;
}

export type AdmissionDecision =
  | { admitted: true; slot: AdmissionSlot; queuedMs: number; pressure: MemoryPressureLevel }
  | { admitted: false; reason: "pressure" | "timeout"; queuedMs: number; pressure: MemoryPressureLevel };

interface RunningSlot { id: number; heavy: boolean }

interface Waiter {
  heavy: boolean;
  enqueuedAt: number;
  timer?: NodeJS.Timeout;
  settle: (decision: AdmissionDecision) => void;
}

export const DEFAULT_MAX_CONCURRENT = 2;
export const DEFAULT_MAX_HEAVY = 1;
export const DEFAULT_SLOT_TIMEOUT_MS = 300_000;
const DEFAULT_PRESSURE_TTL_MS = 2_000;

/** Parses `memory_pressure -Q` output. Unparseable output is treated as healthy. */
export function parseMemoryPressure(output: string): MemoryPressureLevel {
  const match = /free\s+percentage:\s*(\d+)\s*%/i.exec(output) || /(\d+)\s*%/.exec(output);
  if (!match) return "ok";
  const free = Number(match[1]);
  if (!Number.isFinite(free)) return "ok";
  if (free < 5) return "critical";
  if (free < 10) return "warn";
  return "ok";
}

/** Samples macOS memory pressure. Any failure (non-macOS, missing binary) reads as "ok". */
export function sampleMemoryPressure(): Promise<MemoryPressureLevel> {
  return new Promise<MemoryPressureLevel>((resolve) => {
    try {
      execFile(
        "memory_pressure",
        ["-Q"],
        { timeout: 1_500, env: safeEnvironment(), encoding: "utf8" },
        (error, stdout) => resolve(error ? "ok" : parseMemoryPressure(stdout)),
      );
    } catch { resolve("ok"); }
  });
}

export class AdmissionController {
  private readonly maxConcurrent: number;
  private readonly maxHeavy: number;
  private readonly samplePressure: MemoryPressureSampler;
  private readonly pressureTtlMs: number;
  private readonly running: RunningSlot[] = [];
  private readonly queue: Waiter[] = [];
  private nextId = 1;
  private pumping = false;
  private pumpRequested = false;
  private cachedPressure: MemoryPressureLevel = "ok";
  private cachedAt = 0;

  constructor(options: AdmissionControllerOptions = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    this.maxHeavy = Math.max(1, options.maxHeavy ?? DEFAULT_MAX_HEAVY);
    this.samplePressure = options.samplePressure ?? sampleMemoryPressure;
    this.pressureTtlMs = options.pressureTtlMs ?? DEFAULT_PRESSURE_TTL_MS;
  }

  get runningCount(): number { return this.running.length; }
  get queuedCount(): number { return this.queue.length; }

  snapshot(): { running: number; heavyRunning: number; queued: number; pressure: MemoryPressureLevel } {
    return {
      running: this.running.length,
      heavyRunning: this.running.filter((slot) => slot.heavy).length,
      queued: this.queue.length,
      pressure: this.cachedPressure,
    };
  }

  /**
   * Requests permission to spawn. Resolves as soon as a slot frees up (FIFO),
   * or with `admitted: false` when memory pressure is critical or the wait
   * exceeds `timeoutMs`. Callers must `release()` an admitted slot.
   */
  waitForSlot(request: SlotRequest = {}): Promise<AdmissionDecision> {
    const heavy = request.heavy ?? request.provider === "claude";
    const timeoutMs = request.timeoutMs ?? DEFAULT_SLOT_TIMEOUT_MS;
    return new Promise<AdmissionDecision>((resolve) => {
      let settled = false;
      const waiter: Waiter = {
        heavy,
        enqueuedAt: Date.now(),
        settle: (decision) => {
          if (settled) return;
          settled = true;
          if (waiter.timer) clearTimeout(waiter.timer);
          resolve(decision);
        },
      };
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        waiter.timer = setTimeout(() => {
          this.remove(waiter);
          waiter.settle({
            admitted: false, reason: "timeout",
            queuedMs: Date.now() - waiter.enqueuedAt, pressure: this.cachedPressure,
          });
        }, timeoutMs);
        waiter.timer.unref?.();
      }
      this.queue.push(waiter);
      void this.pump();
    });
  }

  private remove(waiter: Waiter): void {
    const index = this.queue.indexOf(waiter);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private hasCapacity(heavy: boolean): boolean {
    if (this.running.length >= this.maxConcurrent) return false;
    if (heavy && this.running.filter((slot) => slot.heavy).length >= this.maxHeavy) return false;
    return true;
  }

  private async readPressure(): Promise<MemoryPressureLevel> {
    const now = Date.now();
    if (now - this.cachedAt < this.pressureTtlMs) return this.cachedPressure;
    try { this.cachedPressure = await this.samplePressure(); } catch { this.cachedPressure = "ok"; }
    this.cachedAt = Date.now();
    return this.cachedPressure;
  }

  private grant(heavy: boolean): AdmissionSlot {
    const entry: RunningSlot = { id: this.nextId++, heavy };
    this.running.push(entry);
    let released = false;
    return {
      id: entry.id,
      heavy,
      release: () => {
        if (released) return;
        released = true;
        const index = this.running.indexOf(entry);
        if (index >= 0) this.running.splice(index, 1);
        void this.pump();
      },
    };
  }

  /** Drains the FIFO queue. Single-flight: concurrent calls coalesce into one pass. */
  private async pump(): Promise<void> {
    if (this.pumping) { this.pumpRequested = true; return; }
    this.pumping = true;
    try {
      do {
        this.pumpRequested = false;
        while (this.queue.length > 0) {
          const head = this.queue[0] as Waiter;
          if (!this.hasCapacity(head.heavy)) break;
          const pressure = await this.readPressure();
          // The queue may have moved while we sampled; re-evaluate from the top.
          if (this.queue[0] !== head) continue;
          if (pressure === "critical") {
            this.queue.shift();
            head.settle({
              admitted: false, reason: "pressure",
              queuedMs: Date.now() - head.enqueuedAt, pressure,
            });
            continue;
          }
          // A warning reading pauses new spawns until the machine is alone again.
          if (pressure === "warn" && this.running.length >= 1) break;
          if (!this.hasCapacity(head.heavy)) break;
          this.queue.shift();
          head.settle({
            admitted: true, slot: this.grant(head.heavy),
            queuedMs: Date.now() - head.enqueuedAt, pressure,
          });
        }
      } while (this.pumpRequested);
    } finally {
      this.pumping = false;
    }
  }
}

// Module-level singleton: every ProviderRunner (Luna, HenryAgent, scheduler)
// admits through the same controller without threading it through constructors.
let shared: AdmissionController | undefined;

export function sharedAdmissionController(): AdmissionController {
  if (!shared) shared = new AdmissionController();
  return shared;
}

/** Test seam: swap (or clear, with `undefined`) the process-wide controller. */
export function setSharedAdmissionController(controller: AdmissionController | undefined): void {
  shared = controller;
}
