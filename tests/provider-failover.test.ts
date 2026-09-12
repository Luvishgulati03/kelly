import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ActivityLog } from "../src/activity.ts";
import { AdmissionController } from "../src/orchestration/admission.ts";
import {
  FAILOVER_ACTIVITY_KIND,
  PREFLIGHT_ACTIVITY_KIND,
  ProviderRunner,
  failoverInfo,
  readFallbackPolicy,
  type ProviderRunnerDeps,
} from "../src/providers/runner.ts";
import {
  DEFAULT_LIMIT_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  ProviderLimitLedger,
  classifyLimit,
  configureProviderLimits,
  describeLimited,
  detectRunLimit,
  earliestReset,
  limitState,
  parseResetAt,
  providerAvailable,
} from "../src/providers/limits.ts";
import type { HenryConfig } from "../src/config.ts";
import type { ActivityEvent, ProviderName, RunResult } from "../src/types.ts";

/* ------------------------------------------------------------------ *
 * 1. Limit classification table (limit vs ordinary error)
 * ------------------------------------------------------------------ */

const LIMIT_FIXTURES: { label: string; text: string }[] = [
  { label: "claude usage limit with reset", text: "Claude usage limit reached. Your limit will reset at 2:30am (Asia/Kolkata)" },
  { label: "claude 5-hour window", text: "5-hour limit reached ∙ resets 3pm" },
  { label: "claude possessive", text: "You've reached your usage limit for this session." },
  { label: "claude rate_limit_error", text: 'API error: {"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}' },
  { label: "codex usage limit", text: "You've hit your usage limit. Try again in 4 hours." },
  { label: "codex quota", text: "stream error: quota exceeded for this organization" },
  { label: "codex 429", text: "request failed: 429 Too Many Requests" },
  { label: "weekly plan limit", text: "Your weekly limit has been reached; upgrade to keep going." },
  { label: "credits", text: "Your credit balance is too low to run this request." },
  { label: "uppercase", text: "USAGE LIMIT REACHED" },
];

const ORDINARY_FIXTURES: { label: string; text: string }[] = [
  { label: "missing file", text: "Error: ENOENT: no such file or directory, open '/tmp/nope.ts'" },
  { label: "type error in the user's own rate limiter", text: "TypeError: Cannot read properties of undefined (reading 'map')\n    at rateLimit (src/server.ts:42:9)" },
  { label: "a source file named rate_limit", text: "error: failed to apply patch to src/rate_limit.ts" },
  { label: "server 500", text: "request failed with status 500 Internal Server Error" },
  { label: "context window overflow", text: "prompt is too long: 250000 tokens exceeds the 200000 maximum context length limit" },
  { label: "concurrency cap", text: "concurrency limit reached: 2 workers already running" },
  { label: "ulimit", text: "ulimit exceeded: too many open files" },
  { label: "bare exit", text: "Provider exited with code 1" },
  { label: "empty", text: "" },
  { label: "429 as a line number", text: "at Object.<anonymous> (src/index.ts:429:11)" },
];

test("classifyLimit flags real limit notices from both CLIs", () => {
  for (const fixture of LIMIT_FIXTURES) {
    const detection = classifyLimit(fixture.text);
    assert.equal(detection.limited, true, `should be a LIMIT: ${fixture.label}`);
    assert.equal(detection.kind, "limit");
    assert.ok(detection.matched, "the matching pattern name is carried for diagnosis");
    assert.ok(detection.reason && detection.reason.length > 0);
  }
});

test("classifyLimit stays quiet on ordinary failures (a false positive parks a healthy CLI)", () => {
  for (const fixture of ORDINARY_FIXTURES) {
    assert.equal(classifyLimit(fixture.text).limited, false, `must NOT be a limit: ${fixture.label}`);
  }
});

test("detectRunLimit trusts stdout only while the reply is terse", () => {
  const notice = "Claude usage limit reached · resets 2:30am";
  assert.equal(detectRunLimit({ response: notice }).limited, true, "a terse notice printed as the answer counts");

  const essay = `${"Rate limit design notes: bucket per key, refill per second, and a 429 on overflow. ".repeat(8)}`;
  assert.ok(essay.length > 400);
  assert.equal(detectRunLimit({ response: essay }).limited, false, "a long answer ABOUT rate limits is not hitting one");

  assert.equal(
    detectRunLimit({ response: essay, error: "You've hit your usage limit." }).limited,
    true,
    "stderr/error evidence counts regardless of reply length",
  );
  assert.equal(
    detectRunLimit({ response: "", events: [{ stream: "stderr", text: "429 Too Many Requests (retry later)" }] }).limited,
    true,
    "stderr events are evidence",
  );
});

/* ------------------------------------------------------------------ *
 * 2. Reset-time parsing (including absent)
 * ------------------------------------------------------------------ */

const NOON = new Date("2026-08-16T12:00:00.000+05:30");

test("parseResetAt reads a 12-hour clock reset as the next local occurrence", () => {
  const later = parseResetAt("Claude usage limit reached · resets 3pm", NOON);
  assert.ok(later);
  const parsed = new Date(later);
  assert.equal(parsed.getHours(), 15);
  assert.equal(parsed.getMinutes(), 0);
  assert.equal(parsed.getDate(), NOON.getDate(), "a time still ahead today stays today");

  const tomorrow = parseResetAt("Your limit will reset at 2:30am (Asia/Kolkata)", NOON);
  assert.ok(tomorrow);
  const wrapped = new Date(tomorrow);
  assert.equal(wrapped.getHours(), 2);
  assert.equal(wrapped.getMinutes(), 30);
  assert.ok(wrapped.getTime() > NOON.getTime(), "a time already past today rolls to tomorrow");
});

test("parseResetAt reads 24-hour, relative, retry-after and ISO forms", () => {
  const clock24 = parseResetAt("limit reached, resets at 15:45", NOON);
  assert.ok(clock24 && new Date(clock24).getHours() === 15 && new Date(clock24).getMinutes() === 45);

  const relative = parseResetAt("You've hit your usage limit. Try again in 4 hours.", NOON);
  assert.equal(relative, new Date(NOON.getTime() + 4 * 3600_000).toISOString());

  const minutes = parseResetAt("rate limit exceeded — retry in 20 minutes", NOON);
  assert.equal(minutes, new Date(NOON.getTime() + 20 * 60_000).toISOString());

  const retryAfter = parseResetAt("429 Too Many Requests (Retry-After: 3600)", NOON);
  assert.equal(retryAfter, new Date(NOON.getTime() + 3600_000).toISOString());

  const iso = parseResetAt("usage limit reached; resets 2026-08-16T14:00:00.000Z", NOON);
  assert.equal(iso, "2026-08-16T14:00:00.000Z");
});

test("parseResetAt returns undefined when the CLI names no time, and clamps absurd ones", () => {
  assert.equal(parseResetAt("You've hit your usage limit.", NOON), undefined);
  assert.equal(parseResetAt("Claude usage limit reached", NOON), undefined);
  assert.equal(parseResetAt("", NOON), undefined);
  assert.equal(parseResetAt("no reset wording at all here", NOON), undefined);

  const absurd = parseResetAt("usage limit reached, try again in 30 days", NOON);
  assert.equal(absurd, new Date(NOON.getTime() + MAX_COOLDOWN_MS).toISOString(), "a mis-parse can never bench a CLI for days");
});

/* ------------------------------------------------------------------ *
 * Harness: a fake CLI seam (no subprocess is ever spawned here)
 * ------------------------------------------------------------------ */

interface Attempt { provider: ProviderName; args: string[] }
type Script = Partial<Record<ProviderName, Partial<RunResult> | (() => Partial<RunResult>)>>;

const OK: Partial<RunResult> = { exitCode: 0, response: "done" };
const CLAUDE_LIMIT: Partial<RunResult> = { exitCode: 1, response: "", error: "Claude usage limit reached. Your limit will reset at 2:30am" };
const CODEX_LIMIT: Partial<RunResult> = { exitCode: 1, response: "", error: "You've hit your usage limit. Try again in 4 hours." };
const ORDINARY_FAILURE: Partial<RunResult> = { exitCode: 1, response: "", error: "TypeError: cannot read properties of undefined" };

interface Harness {
  runner: ProviderRunner;
  attempts: Attempt[];
  events: () => Promise<ActivityEvent[]>;
  dataDir: string;
  settingsPath: string;
  config: HenryConfig;
  activity: ActivityLog;
  notified: string[];
  deps: ProviderRunnerDeps;
  admission: AdmissionController;
}

async function harness(setup: {
  provider?: ProviderName;
  script?: Script;
  settings?: Record<string, unknown>;
  now?: Date;
} = {}): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "henry-failover-"));
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const settingsPath = path.join(dataDir, "settings.json");
  if (setup.settings) await fs.writeFile(settingsPath, JSON.stringify(setup.settings), "utf8");
  const activity = new ActivityLog(path.join(dataDir, "activity.jsonl"));
  await activity.init();
  const config = {
    rootDir: root, dataDir, settingsPath, provider: setup.provider ?? "claude",
  } as HenryConfig;

  const attempts: Attempt[] = [];
  const notified: string[] = [];
  const script = setup.script ?? {};
  const deps: ProviderRunnerDeps = {
    execute: async (_command, args, _cwd, provider) => {
      attempts.push({ provider, args });
      const entry = script[provider];
      const patch = typeof entry === "function" ? entry() : entry ?? OK;
      return {
        runId: randomUUID(), provider, response: "", exitCode: 0, durationMs: 1, events: [],
        ...patch,
      } satisfies RunResult;
    },
    now: () => setup.now ?? new Date(),
    notify: async (message) => { notified.push(message); },
  };
  const admission = new AdmissionController({ pressureTtlMs: 0, samplePressure: async () => "ok" });
  return {
    runner: new ProviderRunner(config, activity, admission, deps),
    attempts, events: () => activity.list(100), dataDir, settingsPath, config, activity, notified, deps, admission,
  };
}

/* ------------------------------------------------------------------ *
 * 3. Failover happy path
 * ------------------------------------------------------------------ */

test("claude out of tokens → codex answers, with the swap on the activity log", async () => {
  const test1 = await harness({ provider: "claude", script: { claude: CLAUDE_LIMIT, codex: OK } });
  const result = await test1.runner.run("ship it");

  assert.deepEqual(test1.attempts.map((attempt) => attempt.provider), ["claude", "codex"], "exactly one retry, on the other CLI");
  assert.equal(result.provider, "codex");
  assert.equal(result.response, "done");
  assert.equal(result.exitCode, 0);

  const info = failoverInfo(result);
  assert.ok(info, "the answer is annotated with who actually ran");
  assert.equal(info?.from, "claude");
  assert.equal(info?.to, "codex");
  assert.match(info?.reason ?? "", /usage limit/i);
  assert.ok(info?.resetAt, "the parsed reset rides along");

  const events = await test1.events();
  const failover = events.find((event) => event.kind === FAILOVER_ACTIVITY_KIND);
  assert.ok(failover, "a provider.failover event is recorded");
  assert.equal(failover?.metadata?.from, "claude");
  assert.equal(failover?.metadata?.to, "codex");
  assert.ok(failover?.metadata?.reason);

  const entry = test1.runner.limits().entry("claude");
  assert.ok(entry, "claude is parked in the cooldown ledger");
  assert.equal(entry?.kind, "limit");
  assert.equal(entry?.parsedReset, true);
  assert.equal(test1.runner.limits().available("codex"), true, "the CLI that answered stays available");
});

test("the full prompt is re-sent to the other CLI (a session cannot cross providers)", async () => {
  const test2 = await harness({ provider: "claude", script: { claude: CLAUDE_LIMIT, codex: OK } });
  await test2.runner.run("the whole prompt with all the static blocks", { surface: "repl" });
  const codexAttempt = test2.attempts.find((attempt) => attempt.provider === "codex");
  assert.ok(codexAttempt);
  assert.ok(codexAttempt?.args.includes("the whole prompt with all the static blocks"), "the retry carries the FULL prompt");
  assert.ok(!codexAttempt?.args.includes("resume"), "a fresh codex session, never a resume of claude's");
});

test("a clean exit whose whole body is a limit notice is a failure, not an answer", async () => {
  const test3 = await harness({
    provider: "claude",
    script: { claude: { exitCode: 0, response: "Claude usage limit reached ∙ resets 3pm" }, codex: OK },
  });
  const result = await test3.runner.run("hello");
  assert.equal(result.provider, "codex", "the notice never reaches the caller as output");
  assert.equal(test3.runner.limits().blocked("claude"), true);
});

test("an ordinary failure still falls back but NEVER parks a healthy CLI", async () => {
  const test4 = await harness({ provider: "claude", script: { claude: ORDINARY_FAILURE, codex: OK } });
  const result = await test4.runner.run("hello");
  assert.equal(result.provider, "codex", "the pre-existing generic fallback is untouched");
  assert.equal(failoverInfo(result), undefined, "no limit annotation for an ordinary error");
  assert.deepEqual(test4.runner.limits().state(), {}, "no cooldown recorded for an ordinary error");
  const events = await test4.events();
  assert.equal(events.some((event) => event.kind === FAILOVER_ACTIVITY_KIND), false);
});

test("a logged-out CLI counts as unavailable and hands off instead of crash-looping", async () => {
  const test5 = await harness({
    provider: "codex",
    script: { codex: { exitCode: 0, response: "Not logged in · Please run /login" }, claude: OK },
  });
  const result = await test5.runner.run("hello");
  assert.equal(result.provider, "claude");
  assert.equal(failoverInfo(result)?.from, "codex");
  const entry = test5.runner.limits().entry("codex");
  assert.equal(entry?.kind, "auth", "auth failure is a SOFT cooldown, not a quota wall");
  assert.equal(test5.runner.limits().blocked("codex"), false, "soft cooldowns never block a last-resort attempt");
});

/* ------------------------------------------------------------------ *
 * 4. Pinned providers (the caller-pinned-seat doctrine)
 * ------------------------------------------------------------------ */

test("a pinned provider does NOT roam by default — billing stays where the caller put it", async () => {
  const pinned = await harness({ provider: "codex", script: { claude: CLAUDE_LIMIT, codex: OK } });
  const result = await pinned.runner.run("a question", { provider: "claude" });

  assert.deepEqual(pinned.attempts.map((attempt) => attempt.provider), ["claude"], "no silent swap onto the other subscription");
  assert.equal(result.provider, "claude");
  assert.match(result.error ?? "", /out of quota/i);
  assert.match(result.error ?? "", /fallbackPinned/, "the error names the opt-in switch");
  const events = await pinned.events();
  assert.equal(events.some((event) => event.kind === FAILOVER_ACTIVITY_KIND), false);
});

test("providers.fallbackPinned = true opts pinned runs into failover", async () => {
  const opted = await harness({
    provider: "codex",
    script: { claude: CLAUDE_LIMIT, codex: OK },
    settings: { providers: { fallbackPinned: true } },
  });
  const result = await opted.runner.run("edu question", { provider: "claude" });
  assert.deepEqual(opted.attempts.map((attempt) => attempt.provider), ["claude", "codex"]);
  assert.equal(result.provider, "codex");
  assert.equal(failoverInfo(result)?.from, "claude");
});

test("providers.fallback = false disables failover entirely", async () => {
  const off = await harness({
    provider: "claude",
    script: { claude: CLAUDE_LIMIT, codex: OK },
    settings: { providers: { fallback: false } },
  });
  const result = await off.runner.run("hello");
  assert.deepEqual(off.attempts.map((attempt) => attempt.provider), ["claude"]);
  assert.match(result.error ?? "", /out of quota/i);
});

test("readFallbackPolicy defaults: fallback ON, pinned fallback OFF", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "henry-policy-"));
  const settingsPath = path.join(root, "settings.json");
  assert.deepEqual(readFallbackPolicy(settingsPath), { fallback: true, fallbackPinned: false }, "a missing file is the default");
  await fs.writeFile(settingsPath, JSON.stringify({ provider: "claude", providers: { fallbackPinned: true } }), "utf8");
  assert.deepEqual(readFallbackPolicy(settingsPath), { fallback: true, fallbackPinned: true });
  await fs.writeFile(settingsPath, JSON.stringify({ providers: { fallback: false } }), "utf8");
  assert.deepEqual(readFallbackPolicy(settingsPath), { fallback: false, fallbackPinned: false });
});

/* ------------------------------------------------------------------ *
 * 5. Both limited → one clear combined error, with the earliest reset
 * ------------------------------------------------------------------ */

test("both CLIs out of quota → a combined error naming the earliest reset, then no doomed spawns", async () => {
  const now = new Date("2026-08-16T12:00:00.000+05:30");
  const both = await harness({ provider: "claude", script: { claude: CLAUDE_LIMIT, codex: CODEX_LIMIT }, now });
  const first = await both.runner.run("hello");

  assert.deepEqual(both.attempts.map((attempt) => attempt.provider), ["claude", "codex"], "each CLI gets exactly one try");
  const state = both.runner.limits().state(now);
  assert.ok(state.claude && state.codex, "both are parked");
  assert.match(first.error ?? "", /Both provider CLIs are out of quota/);
  assert.ok(first.error?.includes(state.claude?.until ?? "?"), "claude's reset is in the message");
  assert.ok(first.error?.includes(state.codex?.until ?? "?"), "codex's reset is in the message");
  const earliest = earliestReset(state);
  assert.ok(earliest);
  assert.ok(first.error?.includes(`Earliest reset ${earliest}`), "the human is told when the first one returns");
  assert.match(first.error ?? "", /Last error:/, "the underlying CLI error is still visible");

  // Second run: nothing is spawned at all — the ledger answers instantly.
  const before = both.attempts.length;
  const second = await both.runner.run("hello again");
  assert.equal(both.attempts.length, before, "a run with every candidate parked must not spawn anything");
  assert.match(second.error ?? "", /Both provider CLIs are out of quota/);
  assert.ok(second.error?.includes(`Earliest reset ${earliest}`));
  const refusal = (await both.events()).find((event) => event.kind === "run.failed" && event.metadata?.limited === true);
  assert.ok(refusal, "the refusal is on the activity stream");
});

test("describeLimited/earliestReset pick the soonest return", () => {
  const state = {
    claude: { until: "2026-08-16T18:00:00.000Z", reason: "usage limit reached", kind: "limit" as const, since: "2026-08-16T06:00:00.000Z" },
    codex: { until: "2026-08-16T15:00:00.000Z", reason: "usage limit reached", kind: "limit" as const, since: "2026-08-16T06:00:00.000Z" },
  };
  assert.equal(earliestReset(state), "2026-08-16T15:00:00.000Z");
  assert.match(describeLimited(state), /Earliest reset 2026-08-16T15:00:00\.000Z/);
  assert.equal(earliestReset({}), undefined);
});

/* ------------------------------------------------------------------ *
 * 6. Pre-flight switch + cooldown persistence across runner instances
 * ------------------------------------------------------------------ */

test("a known-limited default provider is skipped before spawning (pre-flight switch)", async () => {
  const preflight = await harness({ provider: "claude", script: { claude: CLAUDE_LIMIT, codex: OK } });
  preflight.runner.limits().markLimited("claude", { limited: true, kind: "limit", reason: "usage limit reached" });

  const result = await preflight.runner.run("hello");
  assert.deepEqual(preflight.attempts.map((attempt) => attempt.provider), ["codex"], "the doomed attempt is skipped entirely");
  assert.equal(result.provider, "codex");
  const events = await preflight.events();
  const switched = events.find((event) => event.kind === PREFLIGHT_ACTIVITY_KIND);
  assert.ok(switched, "the skip is recorded");
  assert.equal(switched?.metadata?.from, "claude");
  assert.equal(switched?.metadata?.to, "codex");
});

test("a cooldown survives a restart: a brand-new runner over the same data dir remembers", async () => {
  const first = await harness({ provider: "claude", script: { claude: CLAUDE_LIMIT, codex: OK } });
  await first.runner.run("hello");
  const ledgerFile = path.join(first.dataDir, "provider-limits.json");
  assert.ok(existsSync(ledgerFile), "the ledger is persisted under dataDir");
  const persisted = JSON.parse(readFileSync(ledgerFile, "utf8")) as Record<string, { until: string }>;
  assert.ok(persisted.claude?.until, "claude's reset time is on disk");

  // "Daemon restart": a fresh ActivityLog + a fresh ProviderRunner over the same dataDir.
  const attempts: Attempt[] = [];
  const activity = new ActivityLog(path.join(first.dataDir, "activity.jsonl"));
  await activity.init();
  const restarted = new ProviderRunner(
    first.config,
    activity,
    new AdmissionController({ pressureTtlMs: 0, samplePressure: async () => "ok" }),
    {
      execute: async (_command, args, _cwd, provider) => {
        attempts.push({ provider, args });
        return { runId: randomUUID(), provider, response: "done", exitCode: 0, durationMs: 1, events: [] };
      },
    },
  );
  assert.equal(restarted.limits().blocked("claude"), true, "the restarted runner still knows claude is out");
  const result = await restarted.run("after restart");
  assert.deepEqual(attempts.map((attempt) => attempt.provider), ["codex"], "it does not walk back into the same wall");
  assert.equal(result.provider, "codex");
});

test("a soft (logged-out) cooldown demotes a provider but never blocks the last resort", async () => {
  const demoted = await harness({ provider: "claude", script: { claude: OK, codex: OK } });
  demoted.runner.limits().markLimited("claude", { limited: true, kind: "auth", reason: "logged out" });
  const preferOther = await demoted.runner.run("hello");
  assert.equal(preferOther.provider, "codex", "with an alternative available, the healthy CLI goes first");

  // Pinned to the soft-limited CLI: it is the ONLY candidate, so it must still be tried —
  // the operator may have re-logged in a second ago.
  const lastResort = await demoted.runner.run("hello", { provider: "claude" });
  assert.equal(lastResort.provider, "claude");
  assert.equal(lastResort.response, "done");
  assert.equal(demoted.runner.limits().available("claude"), true, "real work proves the CLI is back");
});

/* ------------------------------------------------------------------ *
 * 7. Ledger mechanics + the exported status API
 * ------------------------------------------------------------------ */

test("the ledger falls back to 45 minutes when the CLI names no reset time, and expires on its own", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-ledger-"));
  const file = path.join(dir, "provider-limits.json");
  const now = new Date("2026-08-16T06:00:00.000Z");
  const ledger = new ProviderLimitLedger(file);

  const entry = ledger.markLimited("codex", { limited: true, kind: "limit", reason: "usage limit reached" }, now);
  assert.equal(entry.until, new Date(now.getTime() + DEFAULT_LIMIT_COOLDOWN_MS).toISOString());
  assert.equal(entry.parsedReset, undefined);
  assert.equal(ledger.available("codex", now), false);
  assert.equal(ledger.blocked("codex", now), true);

  const later = new Date(now.getTime() + DEFAULT_LIMIT_COOLDOWN_MS + 1);
  assert.equal(ledger.available("codex", later), true, "the cooldown expires by itself");
  assert.deepEqual(ledger.state(later), {}, "expired entries are pruned");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {}, "and pruned from disk too");
});

test("a corrupt ledger file fails OPEN (never a lockout)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-ledger-bad-"));
  const file = path.join(dir, "provider-limits.json");
  await fs.writeFile(file, "{not json", "utf8");
  const ledger = new ProviderLimitLedger(file);
  assert.deepEqual(ledger.state(), {});
  assert.equal(ledger.available("claude"), true);
  assert.equal(ledger.available("codex"), true);
});

test("limitState()/providerAvailable() expose provider health for :status", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-status-"));
  const file = path.join(dir, "provider-limits.json");
  configureProviderLimits(file);
  assert.deepEqual(limitState(), {}, "nothing limited reads as an empty record");
  assert.equal(providerAvailable("claude"), true);

  new ProviderLimitLedger(file).markLimited("claude", { limited: true, kind: "limit", reason: "usage limit reached", resetAt: "2099-01-01T00:00:00.000Z" });
  assert.equal(providerAvailable("claude"), false);
  assert.equal(providerAvailable("codex"), true);
  const state = limitState();
  assert.ok(state.claude?.until);
  assert.equal(state.claude?.reason, "usage limit reached");
  assert.equal(state.claude?.kind, "limit");
});
