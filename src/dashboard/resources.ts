import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface ResourceChildren {
  codex: number;
  claude: number;
  chromium: number;
  node: number;
}

export interface MemoryPressure {
  freePercent: number;
  level: "normal" | "warn" | "critical";
}

export interface ResourceSample {
  /** RSS of this dashboard/runtime process, in bytes (process.memoryUsage().rss). */
  rss: number;
  /** Per-category RSS across all matching OS processes, in bytes. */
  children: ResourceChildren;
  /** Sum of all child categories, in bytes — the "agent stack" total used for the RAM budget bar. */
  totalRssBytes: number;
  /** macOS memory_pressure reading; null when unavailable (non-macOS, or the binary failed). */
  memoryPressure: MemoryPressure | null;
}

// Order matters: first matching pattern wins, so more specific categories should precede "node".
const CATEGORY_PATTERNS: Array<[keyof ResourceChildren, RegExp]> = [
  ["codex", /codex/i],
  ["claude", /claude/i],
  ["chromium", /chromium|chrome/i],
  ["node", /node/i],
];

/** Samples `ps -axo pid,rss,comm`, bucketing RSS (KB -> bytes) by process-name category. */
async function sampleChildren(): Promise<ResourceChildren> {
  const totals: ResourceChildren = { codex: 0, claude: 0, chromium: 0, node: 0 };
  try {
    const { stdout } = await execAsync("ps -axo pid,rss,comm", { timeout: 5000 });
    const lines = stdout.split("\n").slice(1);
    for (const line of lines) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      const rssKb = Number(match[2]);
      const comm = match[3];
      if (!Number.isFinite(rssKb)) continue;
      for (const [category, pattern] of CATEGORY_PATTERNS) {
        if (pattern.test(comm)) { totals[category] += rssKb * 1024; break; }
      }
    }
  } catch { /* ps unavailable or failed; totals stay at zero */ }
  return totals;
}

/** Parses macOS `memory_pressure -Q` for the system-wide free percentage; null on any failure. */
async function sampleMemoryPressure(): Promise<MemoryPressure | null> {
  try {
    const { stdout } = await execAsync("memory_pressure -Q 2>/dev/null", { timeout: 5000 });
    const match = stdout.match(/System-wide memory free percentage:\s*(\d+)%/);
    if (!match) return null;
    const freePercent = Number(match[1]);
    if (!Number.isFinite(freePercent)) return null;
    const level: MemoryPressure["level"] = freePercent < 10 ? "critical" : freePercent < 25 ? "warn" : "normal";
    return { freePercent, level };
  } catch { return null; }
}

/** How long a sample stays fresh enough to hand back without re-shelling out. */
const SAMPLE_TTL_MS = 2000;

/**
 * Module-level memo (dashboard-design-v2.md perf note): sampleResources() shells out to
 * `ps` and `memory_pressure`, and both the SSE tick and GET /api/resources call it — one
 * SSE client polling every 2s used to mean a fresh `ps`/`memory_pressure` spawn every 2s
 * PER CLIENT, and overlapping timer ticks could even spawn a second pair before the first
 * had returned. A sample younger than SAMPLE_TTL_MS is handed back as-is; a sample already
 * in flight is awaited (never re-started) so concurrent callers share one subprocess pair.
 */
let cachedSample: { at: number; sample: ResourceSample } | null = null;
let inFlight: Promise<ResourceSample> | null = null;

async function collectSample(): Promise<ResourceSample> {
  const [children, memoryPressure] = await Promise.all([sampleChildren(), sampleMemoryPressure()]);
  const rss = process.memoryUsage().rss;
  const totalRssBytes = children.codex + children.claude + children.chromium + children.node;
  return { rss, children, totalRssBytes, memoryPressure };
}

export async function sampleResources(): Promise<ResourceSample> {
  if (cachedSample && Date.now() - cachedSample.at < SAMPLE_TTL_MS) return cachedSample.sample;
  if (inFlight) return inFlight;
  inFlight = collectSample();
  try {
    const sample = await inFlight;
    cachedSample = { at: Date.now(), sample };
    return sample;
  } finally {
    inFlight = null;
  }
}
