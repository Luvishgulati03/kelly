import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ApprovalStore } from "../src/approval/store.ts";
import { ActivityLog } from "../src/activity.ts";
import type { ProviderRunner } from "../src/providers/runner.ts";
import type { ReviewFinding } from "../src/types.ts";
import { PullRequestReviewer } from "../src/pr/review.ts";
import {
  dedupeFindings,
  fetchPriorFindings,
  fingerprintFinding,
  isHenryAuthored,
  normalizeTokens,
  renderFindingMarker,
  type ChangedLineIndex,
  type CommandExecutor,
  type PriorFinding,
} from "../src/pr/dedup.ts";

const result = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });

function finding(line: number, body = "This call may throw when user is null."): ReviewFinding {
  return { severity: "warning", title: "Missing null guard for user", body, path: "src/user.ts", line, side: "RIGHT" };
}

function priorFor(value: ReviewFinding, commitId = "old-head"): PriorFinding {
  return {
    path: value.path,
    line: value.line,
    severity: value.severity,
    fingerprint: fingerprintFinding(value),
    tokens: normalizeTokens(`${value.title} ${value.body}`),
    commitId,
    source: "inline",
  };
}

test("dedupe keeps distinct findings, suppresses duplicates, and preserves changed-line findings", () => {
  const old = finding(20);
  const reworded = finding(20, "This call can throw if user is nullable.");
  const changedFinding = finding(10);
  const distinct: ReviewFinding = { ...finding(20), title: "N+1 query in user loop", body: "This loop performs one database query per user." };
  const changed: ChangedLineIndex = {
    known: true,
    bySha: new Map([["old-head", new Map([["src/user.ts", new Set([10])]])]]),
  };

  const output = dedupeFindings([old, reworded, changedFinding, distinct], [priorFor(old), priorFor(changedFinding)], changed);

  assert.deepEqual(output.kept.map((item) => item.title), ["Missing null guard for user", "N+1 query in user loop"]);
  assert.equal(output.suppressed.length, 2);
  assert.deepEqual(output.suppressed.map((item) => item.reason), ["identical", "reworded"]);
  assert.equal(output.kept[0]?.line, 10, "a matching finding on changed code must remain reviewable");
});

test("configured Henry login excludes foreign comments even when their body looks like a finding", () => {
  assert.equal(isHenryAuthored({ body: "**warning — Missing null guard**\n\nbody", user: { login: "another-reviewer" } }, "henry"), false);
  assert.equal(isHenryAuthored({ body: `${renderFindingMarker(finding(4))}\n\nbody`, user: { login: "another-reviewer" } }, "henry"), false);
  assert.equal(isHenryAuthored({ body: "**warning — Missing null guard**\n\nbody", user: { login: "HENRY" } }, "henry"), true);
});

test("an unavailable compare does not suppress a finding tied to a prior commit", () => {
  const old = finding(10);
  const output = dedupeFindings([old], [priorFor(old)], { known: false, bySha: new Map() });
  assert.equal(output.kept.length, 1);
  assert.equal(output.suppressed.length, 0);
});

test("fetchPriorFindings walks every inline and top-level comments page", async () => {
  const calls: string[] = [];
  const exec: CommandExecutor = async (_command, args) => {
    const endpoint = args[1] || "";
    calls.push(endpoint);
    const page = Number(endpoint.match(/(?:^|&)page=(\d+)/)?.[1] || 1);
    if (endpoint.includes("/pulls/9/comments")) {
      if (page === 1) {
        const response = result(JSON.stringify([
        { body: "**warning — First finding**\n\nbody", path: "src/a.ts", line: 4, user: { login: "henry" } },
        ...Array.from({ length: 100 }, (_, index) => ({ body: `**warning — Unrelated ${index}**\n\nbody`, path: `src/unrelated-${index}.ts`, line: 1, user: { login: "henry" } })),
        ]));
        return response;
      }
      if (page === 2) return result(JSON.stringify([{ body: "**warning — Second finding**\n\nbody", path: "src/b.ts", line: 8, user: { login: "henry" } }]));
      return result("[]");
    }
    if (endpoint.includes("/issues/9/comments")) {
      if (page === 1) return result(JSON.stringify([{ body: `${renderFindingMarker(finding(12))}\n\n**warning — Top-level finding**\n\nbody`, user: { login: "henry" } }]));
      return result("[]");
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };

  const priors = await fetchPriorFindings(exec, "/tmp", "acme/widgets", 9, "henry");

  assert.equal(priors.length, 103);
  assert.ok(calls.some((call) => call.includes("/pulls/9/comments") && call.includes("page=2")));
  assert.ok(calls.some((call) => call.includes("/issues/9/comments") && call.includes("page=1")));
});

test("review fetches paginated priors and stages only new findings without posting", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "henry-pr-dedup-"));
  const config = { ...loadConfig(root), githubLogin: "henry" };
  const activity = new ActivityLog(config.activityPath);
  const approvals = new ApprovalStore(config.approvalsPath);
  await activity.init();
  await approvals.init();

  const unchanged = finding(20);
  const changed = finding(10);
  const calls: Array<{ command: string; args: string[]; input?: string }> = [];
  const exec: CommandExecutor = async (command, args, _cwd, input) => {
    calls.push({ command, args, input });
    if (command !== "gh") throw new Error(`unexpected command: ${command}`);
    if (args[0] === "pr" && args[1] === "view") {
      return result(JSON.stringify({ number: 7, title: "Test", body: "", url: "https://github.test/acme/widgets/pull/7", headRefOid: "new-head", repository: { nameWithOwner: "acme/widgets" }, comments: [], reviews: [] }));
    }
    if (args[0] === "pr" && args[1] === "diff") return result("diff");
    if (args[0] !== "api") throw new Error(`unexpected gh args: ${args.join(" ")}`);
    const endpoint = args[1] || "";
    const page = Number(endpoint.match(/(?:^|&)page=(\d+)/)?.[1] || 1);
    if (endpoint.includes("/pulls/7/comments")) {
      if (page === 1) return result(JSON.stringify([
        { body: `**warning — ${unchanged.title}**\n\n${unchanged.body}`, path: unchanged.path, line: unchanged.line, commit_id: "old-head", user: { login: "henry" } },
        ...Array.from({ length: 100 }, (_, index) => ({ body: `**warning — Unrelated ${index}**\n\nbody`, path: `src/unrelated-${index}.ts`, line: 1, commit_id: "old-head", user: { login: "henry" } })),
      ]));
      if (page === 2) return result(JSON.stringify([{ body: `**warning — ${changed.title}**\n\n${changed.body}`, path: changed.path, line: changed.line, commit_id: "old-head", user: { login: "henry" } }]));
      return result("[]");
    }
    if (endpoint.includes("/issues/7/comments")) return result("[]");
    if (endpoint.includes("/compare/old-head...new-head")) {
      return result(JSON.stringify({ files: [{ filename: "src/user.ts", patch: "@@ -10,1 +10,1 @@\n-old\n+new" }] }));
    }
    throw new Error(`unexpected API endpoint: ${endpoint}`);
  };
  const runner = {
    run: async () => ({ response: JSON.stringify({ verdict: "changes-requested", summary: "findings", passes: {}, findings: [unchanged, changed] }), provider: "codex", exitCode: 0 }),
  } as unknown as ProviderRunner;
  const reviewer = new PullRequestReviewer(config, activity, approvals, runner, exec);

  const report = await reviewer.review("7", root, "acme/widgets");
  const staged = await approvals.list("pending");

  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]?.line, 10);
  assert.equal(report.suppressedFindings, 1);
  assert.deepEqual(report.suppressedFindingBreakdown, { identical: 1, reworded: 0 });
  assert.equal(staged.length, 1);
  assert.match(staged[0]?.body || "", /Suppressed findings: 1 \(identical: 1, reworded: 0\)/);
  const reviewEvent = (await activity.list(20)).find((event) => event.kind === "pr.reviewed");
  assert.equal(reviewEvent?.metadata?.suppressedFindings, 1);
  assert.deepEqual(reviewEvent?.metadata?.suppressedFindingBreakdown, { identical: 1, reworded: 0 });
  assert.ok(!calls.some((call) => call.args.includes("POST")), "review preparation must not post to GitHub");
  await assert.rejects(() => reviewer.postApproved(staged[0]!), /explicit approval/);
  assert.ok(!calls.some((call) => call.args.includes("POST")), "pending review must not post to GitHub");
});

test("review continues with zero suppression when historical comments are unavailable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "henry-pr-dedup-history-"));
  const config = { ...loadConfig(root), githubLogin: "henry" };
  const activity = new ActivityLog(config.activityPath);
  const approvals = new ApprovalStore(config.approvalsPath);
  await activity.init();
  await approvals.init();

  const calls: string[] = [];
  const exec: CommandExecutor = async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (args[0] === "pr" && args[1] === "view") {
      return result(JSON.stringify({ number: 8, title: "Fresh review", body: "", headRefOid: "head", repository: { nameWithOwner: "acme/widgets" }, comments: [], reviews: [] }));
    }
    if (args[0] === "pr" && args[1] === "diff") return result("diff");
    if (args[0] === "api" && args[1]?.includes("/pulls/8/comments")) return { stdout: "", stderr: "GitHub unavailable", exitCode: 1 };
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  const candidate = finding(4);
  const runner = {
    run: async () => ({ response: JSON.stringify({ verdict: "changes-requested", summary: "fresh", passes: {}, findings: [candidate] }), provider: "codex", exitCode: 0 }),
  } as unknown as ProviderRunner;
  const reviewer = new PullRequestReviewer(config, activity, approvals, runner, exec);

  const report = await reviewer.review("8", root, "acme/widgets");
  const staged = await approvals.list("pending");
  const reviewEvent = (await activity.list(20)).find((event) => event.kind === "pr.reviewed");

  assert.equal(report.findings.length, 1);
  assert.equal(report.suppressedFindings, 0);
  assert.deepEqual(report.suppressedFindingBreakdown, { identical: 0, reworded: 0 });
  assert.equal(staged.length, 1);
  assert.match(staged[0]?.body || "", /Suppressed findings: 0 \(identical: 0, reworded: 0\)/);
  assert.equal(reviewEvent?.metadata?.suppressedFindings, 0);
  assert.equal(reviewEvent?.metadata?.historicalCommentsUnavailable, true);
  assert.ok(calls.some((call) => call.includes("/pulls/8/comments")));
  assert.ok(!calls.some((call) => call.includes("POST")), "history failure must not bypass approval or post");
});
