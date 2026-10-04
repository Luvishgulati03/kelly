import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setActiveProfile } from "../src/profile.ts";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { AdmissionController } from "../src/orchestration/admission.ts";
import { LunaOrchestrator } from "../src/orchestration/luna.ts";
import type { HenryMemory } from "../src/memory/engram.ts";
import {
  CLAUDE_MCP_CONFIG_FILE, KELLY_EXCEL_MCP_ENTRY, KELLY_EXCEL_READ_TOOLS, ProviderRunner,
  claudeInitReport, isAuthFailureRun, kellyClaudeMcpConfig, stableNodePath,
} from "../src/providers/runner.ts";
import { createProviderTextStream, providerStreamText } from "../src/providers/stream-text.ts";
import type { ProviderEvent, RunResult } from "../src/types.ts";
import { tempDir } from "./tmp-dirs.ts";

/**
 * KELLY'S CLAUDE BRAIN, END TO END.
 *
 * A stand-in `claude` on PATH speaks the real CLI's stream-json (init → optional text deltas →
 * assistant → result, shapes observed on Claude Code 2.1.258) and echoes its argv in the init
 * event. Its behaviour is chosen by the prompt, because the runner's environment allowlist
 * deliberately drops arbitrary variables.
 */

const FAKE_CLAUDE = `#!/usr/bin/env node
const argv = process.argv.slice(2);
let i = argv.indexOf("-p") + 1;
while (["--model", "--effort", "--setting-sources", "--session-id", "--resume"].includes(argv[i])) i += 2;
const prompt = argv[i];
const out = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
out({ type: "system", subtype: "init", model: "claude-sonnet-test", argv,
  tools: ["Read", "Bash", "mcp__kelly_excel__excel_read_range", "mcp__kelly_excel__excel_save_edited_copy"],
  mcp_servers: [{ name: "kelly_excel", status: "connected" }] });
if (prompt.includes("AUTH")) {
  out({ type: "assistant", message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] }, error: "authentication_failed" });
  out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
  process.exit(1);
}
if (prompt.includes("ISERROR")) {
  out({ type: "result", subtype: "error_during_execution", is_error: true, result: "Something broke inside the CLI" });
  process.exit(0);
}
const answer = prompt.includes("SCHEMA") ? undefined : "Ten switches cost Rs 1,200.";
if (argv.includes("--include-partial-messages") && answer) {
  out({ type: "stream_event", event: { type: "message_start" } });
  for (const piece of ["Ten switches ", "cost Rs 1,200."]) out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: piece } } });
}
out({ type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: "TOOL OUTPUT MUST NOT LEAK" }] }] } });
if (answer) out({ type: "assistant", message: { content: [{ type: "text", text: answer }] } });
out({ type: "result", subtype: "success", is_error: false,
  result: answer ?? "", ...(answer ? {} : { structured_output: { total_paise: 120000 } }),
  usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 12 } });
`;

function kellyRunner(t: { after(fn: () => void): void }, env: Record<string, string> = {}) {
  setActiveProfile("kelly");
  const saved: Record<string, string | undefined> = {};
  for (const key of ["KELLY_PROVIDER", "KELLY_FAILOVER", ...Object.keys(env)]) saved[key] = process.env[key];
  delete process.env.KELLY_PROVIDER;
  delete process.env.KELLY_FAILOVER;
  Object.assign(process.env, env);
  const bin = tempDir("kelly-fake-claude-", t);
  fs.writeFileSync(path.join(bin, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  t.after(() => {
    process.env.PATH = previousPath;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const config = loadConfig(tempDir("kelly-claude-run-", t));
  const activity = new ActivityLog(config.activityPath);
  const notices: string[] = [];
  const runner = new ProviderRunner(config, activity, new AdmissionController({ samplePressure: async () => "ok" }), {
    notify: async (message: string) => { notices.push(message); },
  });
  const argvOf = (result: RunResult): string[] => claudeInitArgv(result.events);
  return { runner, config, activity, notices, argvOf };
}

function claudeInitArgv(events: ProviderEvent[]): string[] {
  const init = events.find((event) => event.parsed?.type === "system")?.parsed;
  assert.ok(init && Array.isArray(init.argv), "the stand-in claude should have reported its argv");
  return init.argv as string[];
}

test("a Kelly brain run spawns Claude with sonnet, low effort, stream-json and exactly kelly_excel", async (t) => {
  const { runner, config, argvOf, activity } = kellyRunner(t);
  const result = await runner.run("price of ten switches", { timeoutMs: 20_000 });
  assert.equal(result.provider, "claude");
  assert.equal(result.exitCode, 0);
  const mcpConfig = path.join(config.dataDir, CLAUDE_MCP_CONFIG_FILE);
  assert.deepEqual(argvOf(result), [
    "-p", "--model", "sonnet", "--effort", "low", "--setting-sources", "project",
    "price of ten switches",
    "--verbose", "--output-format", "stream-json",
    "--mcp-config", mcpConfig, "--strict-mcp-config",
    "--dangerously-skip-permissions",
  ]);
  assert.equal(result.response, "Ten switches cost Rs 1,200.", "the result event is the answer; tool output never leaks");
  assert.ok(result.firstTextMs !== null && result.firstTextMs !== undefined);
  const completed = (await activity.list(20)).find((event) => event.kind === "run.completed");
  assert.deepEqual(completed?.metadata?.usage, { input: 3210, cached: 3000, output: 12 });
  const started = (await activity.list(20)).find((event) => event.kind === "run.started");
  assert.equal(started?.metadata?.model, "sonnet");
  assert.equal(started?.metadata?.effort, "low");
});

test("the generated MCP config registers only kelly_excel, by absolute path, owner-only", async (t) => {
  const { runner, config } = kellyRunner(t);
  const file = runner.claudeMcpConfig();
  assert.equal(file, path.join(config.dataDir, CLAUDE_MCP_CONFIG_FILE));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers: Record<string, { command: string; args: string[] }> };
  assert.deepEqual(Object.keys(parsed.mcpServers), ["kelly_excel"]);
  const server = parsed.mcpServers.kelly_excel;
  assert.ok(path.isAbsolute(server.command), "node by absolute path");
  assert.deepEqual(server.args, [KELLY_EXCEL_MCP_ENTRY]);
  assert.ok(path.isAbsolute(KELLY_EXCEL_MCP_ENTRY) && fs.existsSync(KELLY_EXCEL_MCP_ENTRY), "the entry point exists in this checkout");
  assert.equal(fs.readFileSync(file, "utf8"), kellyClaudeMcpConfig());
});

test("stableNodePath prefers a PATH entry that resolves to the running node", (t) => {
  const dir = tempDir("kelly-node-link-", t);
  fs.symlinkSync(process.execPath, path.join(dir, "node"));
  assert.equal(stableNodePath(process.execPath, dir), path.join(dir, "node"));
  assert.equal(stableNodePath(process.execPath, ""), process.execPath);
});

test("tiers pick Claude's model and effort: t0 haiku/low, t2 opus/high", async (t) => {
  const { runner, argvOf } = kellyRunner(t);
  const t0 = argvOf(await runner.run("hello", { tier: "t0", timeoutMs: 20_000 }));
  assert.deepEqual(t0.slice(0, 5), ["-p", "--model", "haiku", "--effort", "low"]);
  const t2 = argvOf(await runner.run("hard question", { tier: "t2", timeoutMs: 20_000 }));
  assert.deepEqual(t2.slice(0, 5), ["-p", "--model", "opus", "--effort", "high"]);
});

test("a read-only Kelly run is dontAsk with read tools plus the read-only kelly_excel tools", async (t) => {
  const { runner, argvOf } = kellyRunner(t);
  const args = argvOf(await runner.run("look it up", { readOnly: true, role: "research", timeoutMs: 20_000 }));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  const allowed = args[args.indexOf("--allowedTools") + 1].split(",");
  for (const tool of ["Read", "Grep", "Glob", "WebSearch", "WebFetch", ...KELLY_EXCEL_READ_TOOLS]) assert.ok(allowed.includes(tool), tool);
  assert.ok(!allowed.includes("mcp__kelly_excel__excel_save_edited_copy"), "saving a workbook copy is not a read");
  assert.equal(args[args.indexOf("--disallowedTools") + 1], "Bash,Edit,Write,NotebookEdit");
  assert.ok(args.includes("--strict-mcp-config"));
});

test("a run with a live listener streams partial messages, readable with createProviderTextStream", async (t) => {
  const { runner, argvOf } = kellyRunner(t);
  const visible = createProviderTextStream();
  const pieces: string[] = [];
  const result = await runner.run("price of ten switches", {
    timeoutMs: 20_000,
    onEvent: (event) => { const text = visible(event); if (text) pieces.push(text); },
  });
  assert.ok(argvOf(result).includes("--include-partial-messages"));
  assert.deepEqual(pieces, ["Ten switches ", "cost Rs 1,200."], "deltas stream once; the complete message is not repeated");
  assert.equal(result.response, "Ten switches cost Rs 1,200.");
  const quiet = await runner.run("price of ten switches", { timeoutMs: 20_000, onEvent: () => undefined, partialMessages: false });
  assert.ok(!argvOf(quiet).includes("--include-partial-messages"));
});

test("a structured-output run passes a compact --json-schema and returns structured_output", async (t) => {
  const { runner, argvOf } = kellyRunner(t);
  const schemaPath = path.join(tempDir("kelly-schema-", t), "quote.schema.json");
  fs.writeFileSync(schemaPath, JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { total_paise: { type: "integer" } } }, null, 2));
  const result = await runner.run("SCHEMA quote", { outputSchemaPath: schemaPath, readOnly: true, timeoutMs: 20_000 });
  const args = argvOf(result);
  assert.equal(args[args.indexOf("--json-schema") + 1], '{"type":"object","properties":{"total_paise":{"type":"integer"}}}');
  assert.equal(result.response, '{"total_paise":120000}');
});

test("a result event with is_error is a failure even on a clean exit", async (t) => {
  const { runner, activity } = kellyRunner(t);
  const result = await runner.run("ISERROR please", { timeoutMs: 20_000 });
  assert.equal(result.error, "Something broke inside the CLI");
  const failed = (await activity.list(20)).find((event) => event.kind === "run.failed");
  assert.ok(failed, "recorded as a failed run, not a completed answer");
});

test("a logged-out Claude (nonzero exit) is an auth failure: clear error, cooldown, one notice", async (t) => {
  const { runner, notices } = kellyRunner(t);
  const result = await runner.run("AUTH check", { timeoutMs: 20_000 });
  assert.equal(result.provider, "claude");
  assert.match(result.error ?? "", /claude session logged out — run `claude auth login`/);
  assert.equal(runner.limits().state()["claude"]?.kind, "auth");
  assert.ok(notices.length <= 1);
});

test("auth signatures: Claude's notices are recognised; a healthy short answer is not", () => {
  const base = { provider: "claude" as const, events: [] as ProviderEvent[] };
  assert.equal(isAuthFailureRun({ ...base, exitCode: 0, response: "Invalid API key · Please run /login" }), true);
  assert.equal(isAuthFailureRun({ ...base, exitCode: 1, response: "", error: "OAuth token has expired. Please obtain a new token or refresh your existing token." }), true);
  assert.equal(isAuthFailureRun({ ...base, exitCode: 1, response: "", error: "Run /login to continue" }), true);
  assert.equal(isAuthFailureRun({ ...base, exitCode: 0, response: "Open the shop's /login page to see invoices." }), false);
  assert.equal(isAuthFailureRun({ ...base, exitCode: 1, response: "", error: "Provider exited with code 1" }), false);
});

test("claudeInitReport lists the MCP servers and tools the CLI loaded", () => {
  const events: ProviderEvent[] = [{
    timestamp: "", stream: "stdout", text: "",
    parsed: { type: "system", subtype: "init", model: "m", tools: ["Read", "mcp__kelly_excel__excel_read_range"], mcp_servers: [{ name: "kelly_excel", status: "connected" }] },
  }];
  assert.deepEqual(claudeInitReport(events), {
    model: "m", mcpServers: [{ name: "kelly_excel", status: "connected" }], mcpTools: ["mcp__kelly_excel__excel_read_range"], toolCount: 2,
  });
  assert.equal(claudeInitReport([]), undefined);
});

test("checkClaude reports the kelly_excel tools from the probe's init event", async (t) => {
  const { runner } = kellyRunner(t);
  const report = await runner.checkClaude(20_000);
  assert.equal(report.ok, true);
  assert.deepEqual(report.kellyExcelTools, ["mcp__kelly_excel__excel_read_range", "mcp__kelly_excel__excel_save_edited_copy"]);
  assert.deepEqual(report.otherMcpTools, []);
});

test("Luna's dispatch-and-report research runs read-only on the configured provider", async (t) => {
  const { config, activity } = kellyRunner(t);
  const memory = { remember: async () => undefined } as unknown as HenryMemory;
  const luna = new LunaOrchestrator(config, activity, memory);
  const handle = luna.dispatchAndReport("deep research on LED panel brands");
  const result = await handle.completion;
  assert.equal(result.provider, "claude", "no Codex pin");
  const args = claudeInitArgv(result.events);
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.deepEqual(args.slice(0, 3), ["-p", "--model", "sonnet"]);
});

test("the visible-text reader joins messages, skips sub-agents, and handles Codex", () => {
  const ev = (parsed: Record<string, unknown>): ProviderEvent => ({ timestamp: "", stream: "stdout", text: "", parsed });
  const claude = [
    ev({ type: "system", subtype: "init" }),
    ev({ type: "assistant", message: { content: [{ type: "text", text: "Checking the catalogue." }, { type: "tool_use", name: "Read" }] } }),
    ev({ type: "assistant", parent_tool_use_id: "toolu_1", message: { content: [{ type: "text", text: "sub-agent chatter" }] } }),
    ev({ type: "assistant", message: { content: [{ type: "text", text: "Rs 1,200." }] } }),
    ev({ type: "result", result: "Rs 1,200." }),
  ];
  assert.equal(providerStreamText(claude), "Checking the catalogue.\n\nRs 1,200.");
  const codex = [
    ev({ type: "item.started", item: { type: "agent_message", text: "partial" } }),
    ev({ type: "item.completed", item: { type: "agent_message", text: "First." } }),
    ev({ type: "item.completed", item: { type: "command_execution", aggregated_output: "ls" } }),
    ev({ type: "item.completed", item: { type: "agent_message", text: "Second." } }),
  ];
  assert.equal(providerStreamText(codex), "First.\n\nSecond.");
});
