/**
 * Pure, testable buffer-and-drain state machine for the REPL's "Friday" input queueing:
 * while a run is in flight, new lines are buffered instead of racing the in-flight run;
 * when it finishes, the whole buffer drains as one combined turn. No I/O lives here —
 * `src/cli.ts` owns readline wiring and only calls `start`/`push`/`finish`.
 */

export interface DrainResult {
  combined: string;
  count: number;
}

export interface InputQueue {
  readonly busy: boolean;
  readonly length: number;
  /** Marks a run as in-flight; subsequent `push` calls buffer instead of running immediately. */
  start(): void;
  /** Buffers one line while busy. Returns the new queue length (for the "queued (N)" ack). */
  push(line: string): number;
  /**
   * Ends the in-flight run. If lines were buffered, returns them joined with "\n" plus a
   * count and clears the buffer; returns `undefined` when nothing was queued.
   */
  finish(): DrainResult | undefined;
  /** Read-only view of the buffered lines (for the `:queue` command). */
  pending(): readonly string[];
}

export function createInputQueue(): InputQueue {
  let busy = false;
  let queue: string[] = [];
  return {
    get busy(): boolean { return busy; },
    get length(): number { return queue.length; },
    start(): void { busy = true; },
    push(line: string): number {
      queue.push(line);
      return queue.length;
    },
    finish(): DrainResult | undefined {
      busy = false;
      if (queue.length === 0) return undefined;
      const count = queue.length;
      const combined = queue.join("\n");
      queue = [];
      return { combined, count };
    },
    pending(): readonly string[] { return [...queue]; },
  };
}
