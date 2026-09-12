import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActivityLog } from "../src/activity.ts";
import { AdmissionController } from "../src/orchestration/admission.ts";
import {
  CODEX_T0_MODEL,
  ENVELOPE_TIMEOUT_ERROR,
  ProviderRunner,
  buildProviderArgs,
  claudeArgs,
  codexArgs,
  execute,
  isAuthFailureResponse,
  shouldNotifyAuthFailure,
} from "../src/providers/runner.ts";
import type { HenryConfig } from "../src/config.ts";
import type { ActivityEvent } from "../src/types.ts";

const PROMPT = "do the thing";

test("t0 routes to the cheap models on both CLIs", () => {
  const claude = claudeArgs(PROMPT, { tier: "t0" });
  assert.deepEqual(claude, ["-p", "--model", "haiku", PROMPT, "--dangerously-skip-permissions"]);

  const codex = codexArgs(PROMPT, { readOnly: true, tier: "t0" });
  assert.equal(codex[1], "-m");
  assert.equal(codex[2], CODEX_T0_MODEL);
  assert.ok(!codex.includes('model_reasoning_effort="high"'), "t0 must not raise reasoning effort");
  assert.ok(codex.includes('model_reasoning_effort="low"'), "t0 must explicitly stay fast");
});

test("t0 overrides a configured heavy model rather than inheriting it", () => {
  assert.deepEqual(
    claudeArgs(PROMPT, { tier: "t0", model: "opus" }),
    ["-p", "--model", "haiku", PROMPT, "--dangerously-skip-permissions"],
  );
  const codex = codexArgs(PROMPT, { readOnly: false, tier: "t0", model: "gpt-5-codex" });
  assert.deepEqual(codex.slice(0, 3), ["exec", "-m", CODEX_T0_MODEL]);
});

test("t1 and an absent tier keep the configured default models", () => {
  assert.deepEqual(
    claudeArgs(PROMPT, { tier: "t1", model: "sonnet" }),
    ["-p", "--model", "sonnet", PROMPT, "--dangerously-skip-permissions"],
  );
  assert.deepEqual(
    claudeArgs(PROMPT, {}),
    ["-p", PROMPT, "--dangerously-skip-permissions"],
    "no tier and no configured model leaves the CLI default untouched",
  );
  const codexDefault = codexArgs(PROMPT, { readOnly: false });
  assert.equal(codexDefault[1], "--json", "no -m flag when nothing is configured");
  assert.ok(codexDefault.includes('model_reasoning_effort="low"'), "t1 must keep the Sol coordinator token-efficient");
  const codexConfigured = codexArgs(PROMPT, { readOnly: false, tier: "t1", model: "gpt-5-codex" });
  assert.deepEqual(codexConfigured.slice(0, 3), ["exec", "-m", "gpt-5-codex"]);
});

test("Henry's default t1 coordinator is gpt-5.6-sol at low reasoning", () => {
  const args = codexArgs(PROMPT, { readOnly: true, tier: "t1", model: "gpt-5.6-sol" });
  assert.deepEqual(args.slice(0, 3), ["exec", "-m", "gpt-5.6-sol"]);
  assert.ok(args.includes('model_reasoning_effort="low"'));
  assert.ok(!args.includes('model_reasoning_effort="high"'));
});

test("t2 routes to opus and high Codex reasoning effort", () => {
  assert.deepEqual(
    claudeArgs(PROMPT, { tier: "t2", model: "sonnet" }),
    ["-p", "--model", "opus", PROMPT, "--dangerously-skip-permissions"],
  );
  const codex = codexArgs(PROMPT, { readOnly: false, tier: "t2" });
  const effortIndex = codex.indexOf('model_reasoning_effort="high"');
  assert.ok(effortIndex > 0, "t2 must add the high reasoning effort override");
  assert.equal(codex[effortIndex - 1], "-c");
  assert.ok(codex.includes('approval_policy="never"'), "the approval override survives tiering");
});

test("tiering never introduces an API-key or API-endpoint flag", () => {
  for (const tier of ["t0", "t1", "t2"] as const) {
    for (const args of [claudeArgs(PROMPT, { tier }), codexArgs(PROMPT, { readOnly: false, tier })]) {
      const joined = args.join(" ").toLowerCase();
      assert.ok(!joined.includes("api-key") && !joined.includes("api_key"), `${tier} leaked an API key flag`);
      assert.ok(!joined.includes("--base-url") && !joined.includes("api.anthropic.com"), `${tier} leaked an API endpoint`);
    }
  }
});

test("buildProviderArgs preserves the sandbox contract per provider", () => {
  const readOnly = buildProviderArgs("codex", PROMPT, { readOnly: true, tier: "t2" });
  assert.ok(readOnly.includes("read-only"));
  assert.ok(!readOnly.includes("danger-full-access"));
  const writable = buildProviderArgs("codex", PROMPT, { readOnly: false, tier: "t0", codexModel: "x" });
  assert.ok(writable.includes("danger-full-access"));
  assert.deepEqual(
    buildProviderArgs("claude", PROMPT, { readOnly: false, tier: "t2", claudeModel: "sonnet" }),
    ["-p", "--model", "opus", PROMPT, "--dangerously-skip-permissions"],
  );
});

test("the wall-clock envelope terminates a hung child with a partial result", async () => {
  const started = Date.now();
  const result = await execute("sleep", ["30"], os.tmpdir(), "codex", { timeoutMs: 120 });
  assert.equal(result.exitCode, null);
  assert.equal(result.error, ENVELOPE_TIMEOUT_ERROR);
  assert.ok(Date.now() - started < 5_000, "SIGTERM must fire well before the grace SIGKILL");
  assert.ok(result.events.some((event) => event.stream === "system" && event.text.includes(ENVELOPE_TIMEOUT_ERROR)));
});

test("a child that finishes inside its envelope is unaffected", async () => {
  const result = await execute("echo", ["hello"], os.tmpdir(), "codex", { timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.response, "hello");
  assert.equal(result.error, undefined);
});

test("execute() records firstEventMs on the first stdout line, and firstTextMs stays null when nothing parses as JSON (latency §11.5 round 2)", async () => {
  const result = await execute("echo", ["hello"], os.tmpdir(), "codex", { timeoutMs: 10_000 });
  assert.equal(typeof result.firstEventMs, "number");
  assert.equal(result.firstTextMs, null);
});

test("execute() records firstTextMs from the first stdout line whose parsed JSON carries text (latency §11.5 round 2)", async () => {
  const result = await execute(
    "node",
    ["-e", "console.log(JSON.stringify({ text: 'hi' }))"],
    os.tmpdir(),
    "codex",
    { timeoutMs: 10_000 },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(typeof result.firstEventMs, "number");
  assert.equal(typeof result.firstTextMs, "number");
  assert.ok((result.firstEventMs as number) <= (result.firstTextMs as number));
});

async function testRunner(admission: AdmissionController): Promise<{ runner: ProviderRunner; events: () => Promise<ActivityEvent[]> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "henry-runner-"));
  const activity = new ActivityLog(path.join(root, "activity.jsonl"));
  await activity.init();
  const config = { rootDir: root, dataDir: path.join(root, "data"), provider: "codex" } as HenryConfig;
  return { runner: new ProviderRunner(config, activity, admission), events: () => activity.list(50) };
}

test("critical memory pressure blocks the spawn and is recorded, never executed", async () => {
  const admission = new AdmissionController({ pressureTtlMs: 0, samplePressure: async () => "critical" });
  const { runner, events } = await testRunner(admission);
  const result = await runner.run("never spawn me", { tier: "t0", timeoutMs: 200 });

  assert.equal(result.exitCode, null);
  assert.match(result.error ?? "", /memory pressure critical/);
  assert.equal(result.events.length, 0, "no provider subprocess may be spawned under critical pressure");
  assert.equal(admission.runningCount, 0);

  const recorded = await events();
  const refusal = recorded.find((event) => event.kind === "run.started");
  assert.ok(refusal, "a refused spawn is still recorded on the activity stream");
  assert.equal(refusal?.metadata?.queued, true);
  assert.equal(refusal?.metadata?.refused, "pressure");
  assert.equal(refusal?.metadata?.tier, "t0");
});

test("waiting for a slot longer than the envelope is refused rather than spawned", async () => {
  const admission = new AdmissionController({ maxConcurrent: 1, pressureTtlMs: 0, samplePressure: async () => "ok" });
  const held = await admission.waitForSlot({ provider: "codex", timeoutMs: 1_000 });
  assert.equal(held.admitted, true);

  const { runner, events } = await testRunner(admission);
  const result = await runner.run("queued out", { timeoutMs: 60 });
  assert.equal(result.exitCode, null);
  assert.match(result.error ?? "", /timed out waiting for a provider slot/);
  assert.equal(result.events.length, 0);

  const recorded = await events();
  const refusal = recorded.find((event) => event.kind === "run.started");
  assert.equal(refusal?.metadata?.refused, "timeout");
  assert.ok(recorded.some((event) => event.kind === "run.failed"));
  if (held.admitted) held.slot.release();
});

// run() spawns real "codex"/"claude" binaries (the command name IS the provider), so there is
// no seam to drive the auth-failure fallback branch of the loop without those CLIs installed
// and actually logged out. isAuthFailureResponse and shouldNotifyAuthFailure are the exported
// seams instead — this is the observed live signature ("Not logged in · Please run /login",
// clean exit) that run() now treats as a failure rather than success.
test("isAuthFailureResponse recognizes the exact live codex logout string", () => {
  assert.equal(isAuthFailureResponse("Not logged in · Please run /login"), true);
});

test("isAuthFailureResponse matches known signatures case-insensitively when short", () => {
  assert.equal(isAuthFailureResponse("not logged in"), true);
  assert.equal(isAuthFailureResponse("PLEASE RUN /LOGIN"), true);
  assert.equal(isAuthFailureResponse("Run codex login to continue"), true);
  assert.equal(isAuthFailureResponse("please login"), true);
  assert.equal(isAuthFailureResponse("Authentication required."), true);
  assert.equal(isAuthFailureResponse("401 Unauthorized"), true);
  assert.equal(isAuthFailureResponse("your token expired"), true);
});

test("isAuthFailureResponse trips on a long response only when it STARTS WITH the signature", () => {
  const longFromStart = `Please run /login before continuing. ${"x".repeat(220)}`;
  assert.ok(longFromStart.length >= 200);
  assert.equal(isAuthFailureResponse(longFromStart), true);
});

test("isAuthFailureResponse ignores a long normal reply that merely mentions login mid-text", () => {
  const normalReply = "Here is a summary of the changes: I updated the settings page so the "
    + "login page now redirects correctly after a successful sign-in, added tests for the "
    + "redirect flow, and documented the new behavior in the README so future readers understand "
    + "why the login page changed and how session expiry is now handled end to end across the app.";
  assert.ok(normalReply.length >= 200, "fixture must be long to exercise the guard");
  assert.equal(isAuthFailureResponse(normalReply), false);
});

test("isAuthFailureResponse ignores empty/blank responses", () => {
  assert.equal(isAuthFailureResponse(""), false);
  assert.equal(isAuthFailureResponse("   \n  "), false);
});

test("shouldNotifyAuthFailure debounces per provider for 10 minutes, independently across providers", () => {
  // Anchored far from real wall-clock time so this test can't collide with any other test (in
  // this file or elsewhere) that happens to touch the same module-level debounce map.
  const base = 5_000_000_000_000;
  assert.equal(shouldNotifyAuthFailure("codex", base), true, "first hit notifies");
  assert.equal(shouldNotifyAuthFailure("codex", base + 1_000), false, "debounced well within the window");
  assert.equal(shouldNotifyAuthFailure("codex", base + 9 * 60 * 1000), false, "still debounced just under 10 minutes");
  assert.equal(shouldNotifyAuthFailure("claude", base + 1_000), true, "debounce is per-provider, not global");
  assert.equal(shouldNotifyAuthFailure("codex", base + 10 * 60 * 1000), true, "notifies again once the window has fully elapsed");
});
