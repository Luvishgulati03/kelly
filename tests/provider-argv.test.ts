import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ProviderRunner, buildProviderArgs, claudeArgs, codexArgs,
} from "../src/providers/runner.ts";
import { ActivityLog } from "../src/activity.ts";
import { AdmissionController } from "../src/orchestration/admission.ts";
import { loadConfig } from "../src/config.ts";
import type { DispatchTier, ProviderName } from "../src/types.ts";

/**
 * THE ARGV PINS.
 *
 * Henry is agentic by design: its brain runs CLI commands and edits files on Luvish's machine,
 * and that is the product. The argv each provider CLI is spawned with is therefore load-bearing
 * — `--dangerously-skip-permissions` on claude, `danger-full-access` on codex unless the caller
 * asked for `readOnly`.
 *
 * This file pins that shape BYTE-FOR-BYTE, across every tier, session and model combination
 * either builder can produce, and end-to-end through `run()` against a stand-in executable on
 * PATH. A change to the spawn shape has to be a deliberate edit here, never a side effect.
 */

const TIERS: (DispatchTier | undefined)[] = [undefined, "t0", "t1", "t2"];
const PROVIDERS: ProviderName[] = ["codex", "claude"];
const SESSIONS = [undefined, { id: "s-1", fresh: true }, { id: "s-2", fresh: false }];

interface Shape { label: string; provider: ProviderName; args: string[] }

/** Every argv shape either builder can produce, across readOnly too. */
function everyArgv(): Shape[] {
  const out: Shape[] = [];
  for (const provider of PROVIDERS)
    for (const readOnly of [false, true])
      for (const tier of TIERS)
        for (const session of SESSIONS)
          for (const model of [undefined, "some-model"])
            out.push({
              label: `${provider} readOnly=${readOnly} tier=${tier ?? "none"} session=${session ? (session.fresh ? "fresh" : "resume") : "none"} model=${model ?? "default"}`,
              provider,
              args: buildProviderArgs(provider, "hello", {
                readOnly, tier, session, codexModel: model, claudeModel: model,
              }),
            });
  return out;
}

// ---------------------------------------------------------------------------
// The builders, verbatim.
// ---------------------------------------------------------------------------

test("claude argv is the prompt then --dangerously-skip-permissions", () => {
  // This is the argv Henry's brain has always spawned, and it is how Henry edits files on
  // Luvish's machine.
  assert.deepEqual(claudeArgs("do the thing"), ["-p", "do the thing", "--dangerously-skip-permissions"]);
  assert.deepEqual(
    claudeArgs("p", { tier: "t2", model: "sonnet", session: { id: "abc", fresh: false } }),
    ["-p", "--model", "opus", "--resume", "abc", "p", "--dangerously-skip-permissions"],
  );
});

test("claude argv pins the model and session flags", () => {
  assert.deepEqual(claudeArgs("p", { tier: "t0" }), ["-p", "--model", "haiku", "p", "--dangerously-skip-permissions"]);
  assert.deepEqual(claudeArgs("p", { tier: "t2" }), ["-p", "--model", "opus", "p", "--dangerously-skip-permissions"]);
  assert.deepEqual(
    claudeArgs("p", { model: "sonnet", session: { id: "abc", fresh: true } }),
    ["-p", "--model", "sonnet", "--session-id", "abc", "p", "--dangerously-skip-permissions"],
  );
});

/**
 * Which model serves a tier is a DEPLOYMENT decision on both seats. Codex has always taken
 * its tier models from config; Claude's were literals, so moving the brain back to the Claude
 * seat would have meant editing code. These pin the symmetry — and that the defaults still
 * reproduce the long-standing haiku/opus behaviour when a deployment names nothing.
 */
test("claude tier models come from config, defaulting to the historical haiku/opus", () => {
  assert.deepEqual(
    claudeArgs("p", { tier: "t0", t0Model: "haiku-4-5" }),
    ["-p", "--model", "haiku-4-5", "p", "--dangerously-skip-permissions"],
  );
  assert.deepEqual(
    claudeArgs("p", { tier: "t2", t2Model: "opus-4-8" }),
    ["-p", "--model", "opus-4-8", "p", "--dangerously-skip-permissions"],
  );
  // Unset → exactly what Henry spawned before the tier models became configurable.
  assert.deepEqual(claudeArgs("p", { tier: "t0" }), ["-p", "--model", "haiku", "p", "--dangerously-skip-permissions"]);
  assert.deepEqual(claudeArgs("p", { tier: "t2" }), ["-p", "--model", "opus", "p", "--dangerously-skip-permissions"]);
  // A t2 override must not bleed into t0, and a t1 turn still defers to the CLI default.
  assert.deepEqual(
    claudeArgs("p", { tier: "t0", t0Model: "haiku-4-5", t2Model: "opus-4-8" }),
    ["-p", "--model", "haiku-4-5", "p", "--dangerously-skip-permissions"],
  );
  assert.deepEqual(claudeArgs("p", { t0Model: "haiku-4-5", t2Model: "opus-4-8" }), ["-p", "p", "--dangerously-skip-permissions"]);
});

test("buildProviderArgs carries the claude tier models through", () => {
  assert.deepEqual(
    buildProviderArgs("claude", "p", { readOnly: false, tier: "t2", claudeT0Model: "haiku-4-5", claudeT2Model: "opus-4-8" }),
    ["-p", "--model", "opus-4-8", "p", "--dangerously-skip-permissions"],
  );
  // The codex seat is unaffected by claude's tier config.
  assert.ok(!buildProviderArgs("codex", "p", { readOnly: false, tier: "t2", claudeT2Model: "opus-4-8" }).includes("opus-4-8"));
});

test("codex argv sandbox follows readOnly, and nothing else", () => {
  assert.deepEqual(codexArgs("p", { readOnly: false }), [
    "exec", "--json", "--ephemeral", "--sandbox", "danger-full-access",
    "-c", 'approval_policy="never"', "-c", 'model_reasoning_effort="low"', "--skip-git-repo-check", "p",
  ]);
  assert.deepEqual(codexArgs("p", { readOnly: true }), [
    "exec", "--json", "--ephemeral", "--sandbox", "read-only",
    "-c", 'approval_policy="never"', "-c", 'model_reasoning_effort="low"', "--skip-git-repo-check", "p",
  ]);
  // The operator's own environment is never stripped out from under a run.
  const args = codexArgs("p", { readOnly: false });
  assert.ok(!args.includes("--ignore-user-config"), "a run keeps the operator's config");
  assert.ok(!args.includes("--ignore-rules"), "a run keeps execpolicy rules");
  assert.ok(!args.join(" ").includes("tools.web_search"), "a run does not touch web_search");
});

test("codex argv keeps its tier and session behaviour", () => {
  assert.deepEqual(codexArgs("p", { tier: "t0" }).slice(0, 4), ["exec", "-m", "gpt-5.5", "--json"]);
  assert.ok(codexArgs("p", { tier: "t2" }).join(" ").includes('model_reasoning_effort="high"'));
  const resumed = codexArgs("p", { session: { id: "thread-1", fresh: false } });
  assert.deepEqual(resumed.slice(0, 3), ["exec", "resume", "--json"]);
  assert.ok(resumed.includes('sandbox_mode="danger-full-access"'), "resume preserves the writable sandbox through config");
  assert.equal(resumed.at(-2), "thread-1", "resume options must precede the session id");
  assert.equal(resumed.at(-1), "p");
  assert.ok(!resumed.includes("--ephemeral"), "a session implies persistence");
});

test("every claude argv carries --dangerously-skip-permissions and no tool disallow", () => {
  for (const { provider, args, label } of everyArgv()) {
    if (provider !== "claude") continue;
    assert.ok(args.includes("--dangerously-skip-permissions"), `${label}: claude keeps its permission flag`);
    assert.ok(!args.includes("--tools"), `${label}: claude is not tool-disabled`);
    assert.ok(!args.includes("--strict-mcp-config"), `${label}: claude keeps its MCP servers`);
    assert.ok(args.indexOf("hello") < args.indexOf("--dangerously-skip-permissions"), `${label}: the prompt precedes the trailing flag`);
  }
});

test("every codex argv preserves the correct sandbox, including the resume-only config form", () => {
  for (const { provider, args, label } of everyArgv()) {
    if (provider !== "codex") continue;
    const at = args.indexOf("--sandbox");
    const isResume = args[1] === "resume";
    if (isResume) {
      assert.equal(at, -1, `${label}: resume accepts sandbox only as config`);
      assert.ok(args.some((arg) => arg === 'sandbox_mode="read-only"' || arg === 'sandbox_mode="danger-full-access"'), `${label}: resume sandbox config missing`);
    } else {
      assert.ok(at >= 0, `${label}: --sandbox must be present`);
      assert.ok(["read-only", "danger-full-access"].includes(args[at + 1]), `${label}: unexpected sandbox ${args[at + 1]}`);
      assert.equal(args.filter((arg) => arg === "--sandbox").length, 1, `${label}: exactly one sandbox flag`);
    }
  }
});

// ---------------------------------------------------------------------------
// End-to-end through run().
// ---------------------------------------------------------------------------

/**
 * FAKE-SPAWN SEAM. `execute()` spawns the bare name `claude` / `codex`, resolved from PATH,
 * with `safeEnvironment` passing PATH through. A temp directory of stand-in executables placed
 * at the front of PATH intercepts the REAL spawn — the only way to prove the flags survive the
 * whole run() path (session choice, admission, fallback) and not merely the builder in
 * isolation. Each stand-in prints one JSONL event carrying its own argv.
 */
function fakeProviders(
  t: { after(fn: () => void): void },
  opts: { exit?: Partial<Record<ProviderName, number>>; provider?: ProviderName } = {},
): { runner: ProviderRunner; argvOf(result: { events: { parsed?: Record<string, unknown> }[] }): string[] } {
  const exit = opts.exit ?? {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "henry-fakebin-"));
  for (const name of ["claude", "codex"] as ProviderName[]) {
    fs.writeFileSync(
      path.join(dir, name),
      `#!/usr/bin/env node\n`
      + `process.stdout.write(JSON.stringify({ text: "OK ${name}", argv: process.argv.slice(2) }) + "\\n");\n`
      + `process.exit(${exit[name] ?? 0});\n`,
      { mode: 0o755 },
    );
  }
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ""}`;
  t.after(() => { process.env.PATH = previousPath; fs.rmSync(dir, { recursive: true, force: true }); });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "henry-fakerun-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const config = {
    ...loadConfig(root), rootDir: root, dataDir,
    activityPath: path.join(dataDir, "activity.jsonl"),
    settingsPath: path.join(dataDir, "settings.json"),
    ...(opts.provider ? { provider: opts.provider } : {}),
  };
  const admission = new AdmissionController({ samplePressure: async () => "ok" as const });
  return {
    runner: new ProviderRunner(config, new ActivityLog(config.activityPath), admission),
    argvOf: (result) => {
      const event = result.events.find((e) => Array.isArray(e.parsed?.argv));
      assert.ok(event, "the stand-in provider should have reported its argv");
      return event.parsed!.argv as string[];
    },
  };
}

test("a real spawned claude run is BYTE-IDENTICAL to Henry's long-standing argv", async (t) => {
  const { runner, argvOf } = fakeProviders(t);
  const result = await runner.run("hi", { provider: "claude", role: "repl", timeoutMs: 20_000 });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(argvOf(result), ["-p", "hi", "--dangerously-skip-permissions"]);
});

test("a real spawned codex run keeps danger-full-access when not readOnly", async (t) => {
  const { runner, argvOf } = fakeProviders(t);
  // No role at all — the unlabelled path, which many callers use.
  const result = await runner.run("hi", { provider: "codex", timeoutMs: 20_000 });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(argvOf(result), [
    "exec", "-m", "gpt-5.6-sol", "--json", "--ephemeral", "--sandbox", "danger-full-access",
    "-c", 'approval_policy="never"', "-c", 'model_reasoning_effort="low"', "--skip-git-repo-check", "hi",
  ]);
});

test("the fallback provider of a run keeps the same argv shape", async (t) => {
  // A primary failing must not hand the second provider a different argv. config.provider=codex,
  // unpinned so fallback is allowed; codex exits 3 and claude takes the turn.
  const { runner, argvOf } = fakeProviders(t, { exit: { codex: 3 }, provider: "codex" });
  const result = await runner.run("hi", { role: "standup-scan", timeoutMs: 20_000 });
  assert.equal(result.provider, "claude", "codex exited 3, so claude should have taken the turn");
  assert.deepEqual(argvOf(result), ["-p", "hi", "--dangerously-skip-permissions"]);
});

test("a readOnly run is pinned to the configured provider and never falls back", async (t) => {
  // readOnly's promise: pin to ONE provider, no cross-provider fallback — vision's explicit
  // claude choice must not land on a provider that cannot see the image.
  const { runner } = fakeProviders(t, { exit: { claude: 4 } });
  const result = await runner.run("hi", { provider: "claude", readOnly: true, role: "vision", timeoutMs: 20_000 });
  assert.equal(result.provider, "claude");
  assert.equal(result.exitCode, 4, "claude failed and no codex attempt should have followed");
});
