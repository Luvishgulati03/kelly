import type { ActivityEvent } from "../types.ts";
import type { LimitState } from "../providers/limits.ts";

/**
 * USAGE — what Kelly spent, in the only units a subscription reports honestly.
 *
 * Codex bills nothing per call, so there are no rupees to show. What IS measurable, and
 * already sits in the activity journal, is: runs per day, the tokens each CLI reported for
 * a turn (`run.completed.metadata.usage`), how long each turn took, how long the first text
 * took to appear, and how many seconds of audio were transcribed and how fast. Quota windows
 * come from the cooldown ledger, which records the reset time Codex printed when it refused.
 *
 * Pure: takes events and a clock, returns numbers. The dashboard route feeds it the journal.
 */

export interface UsageDay {
  /** Local calendar day, YYYY-MM-DD. */
  date: string;
  runs: number;
  failedRuns: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  providerMs: number;
  voiceSeconds: number;
  transcriptions: number;
}

export interface UsageSummary {
  windowDays: number;
  days: UsageDay[];
  today: UsageDay;
  latency: { samples: number; p50Ms: number | null; p95Ms: number | null; p50FirstTextMs: number | null };
  voice: {
    transcriptions: number; seconds: number; sttMs: number; realTimeFactor: number | null;
    /** Total characters and wall-clock ms spent in `voice.tts` synthesis calls (chunked
     *  per-sentence calls each contribute their own chars/ms). */
    ttsChars: number; ttsMs: number;
    /** Median of (ms / chars * 100) across individual `voice.tts` events — "typical ms to
     *  speak 100 characters" — or null when there are no samples. */
    ttsP50MsPer100Chars: number | null;
  };
  /** Kelly Talk (hands-free counter loop) sessions in the window, from `talk.session.ended`
   *  activity events. */
  talk: { sessions: number; turns: number };
  /** Live cooldowns per provider ({} when none), straight from the ledger. */
  limits: LimitState;
  /** Fraction of runs that carried token counts; below 1 means some CLIs printed none. */
  tokenCoverage: number;
}

function localDay(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function emptyDay(date: string): UsageDay {
  return { date, runs: 0, failedRuns: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, providerMs: 0, voiceSeconds: 0, transcriptions: 0 };
}

export function summarizeUsage(events: ActivityEvent[], limits: LimitState, now: Date = new Date(), windowDays = 7): UsageSummary {
  const days = new Map<string, UsageDay>();
  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    const d = new Date(now); d.setDate(d.getDate() - offset);
    const key = localDay(d.toISOString());
    days.set(key, emptyDay(key));
  }
  const earliest = new Date(now); earliest.setDate(earliest.getDate() - (windowDays - 1)); earliest.setHours(0, 0, 0, 0);

  const durations: number[] = [];
  const firstText: number[] = [];
  let withTokens = 0;
  let runs = 0;
  let voiceSeconds = 0;
  let sttMs = 0;
  let transcriptions = 0;
  let ttsMs = 0;
  let ttsChars = 0;
  const ttsSamplesPer100Chars: number[] = [];
  let talkSessions = 0;
  let talkTurns = 0;

  for (const event of events) {
    const at = new Date(event.timestamp);
    if (!Number.isFinite(at.getTime()) || at.getTime() < earliest.getTime() || at.getTime() > now.getTime() + 60_000) continue;
    const day = days.get(localDay(event.timestamp));
    if (!day) continue;
    const meta = event.metadata ?? {};
    if (event.kind === "run.completed") {
      runs += 1;
      day.runs += 1;
      const duration = num(meta.durationMs);
      day.providerMs += duration;
      if (duration > 0) durations.push(duration);
      const ft = num(meta.firstTextMs);
      if (ft > 0) firstText.push(ft);
      const usage = meta.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage === "object") {
        withTokens += 1;
        day.inputTokens += num(usage.input);
        day.cachedTokens += num(usage.cached);
        day.outputTokens += num(usage.output);
      }
    } else if (event.kind === "run.failed") {
      day.failedRuns += 1;
    } else if (event.kind === "voice.transcribed") {
      transcriptions += 1;
      day.transcriptions += 1;
      const seconds = num(meta.durationSeconds);
      day.voiceSeconds += seconds;
      voiceSeconds += seconds;
      sttMs += num(meta.sttMs);
    } else if (event.kind === "voice.tts") {
      const chars = num(meta.chars);
      const ms = num(meta.ms);
      ttsChars += chars;
      ttsMs += ms;
      if (chars > 0) ttsSamplesPer100Chars.push((ms / chars) * 100);
    } else if (event.kind === "talk.session.ended") {
      talkSessions += 1;
      talkTurns += num(meta.turns);
    }
  }

  const list = [...days.values()];
  const today = list[list.length - 1] ?? emptyDay(localDay(now.toISOString()));
  return {
    windowDays,
    days: list,
    today,
    latency: { samples: durations.length, p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95), p50FirstTextMs: percentile(firstText, 0.5) },
    voice: {
      transcriptions, seconds: voiceSeconds, sttMs,
      realTimeFactor: voiceSeconds > 0 && sttMs > 0 ? Math.round((sttMs / 1000 / voiceSeconds) * 100) / 100 : null,
      ttsChars, ttsMs, ttsP50MsPer100Chars: percentile(ttsSamplesPer100Chars, 0.5),
    },
    talk: { sessions: talkSessions, turns: talkTurns },
    limits,
    tokenCoverage: runs > 0 ? Math.round((withTokens / runs) * 100) / 100 : 1,
  };
}
