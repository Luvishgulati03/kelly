import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager, sessionArgs, SESSION_STALE_MS, SESSION_MAX_TURNS } from "../src/providers/session.ts";

function manager(): { m: SessionManager; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "henry-session-"));
  const file = path.join(dir, "sessions.json");
  return { m: new SessionManager(file), file };
}

test("first acquire is fresh, second resumes the same id", () => {
  const { m } = manager();
  const first = m.acquire("repl", "claude");
  assert.equal(first.fresh, true);
  m.markUsed("repl", "claude");
  const second = m.acquire("repl", "claude");
  assert.equal(second.fresh, false);
  assert.equal(second.id, first.id);
});

test("stale sessions rotate to a fresh id", () => {
  const { m } = manager();
  const first = m.acquire("repl", "claude");
  m.markUsed("repl", "claude");
  const later = new Date(Date.now() + SESSION_STALE_MS + 1000);
  const rotated = m.acquire("repl", "claude", later);
  assert.equal(rotated.fresh, true);
  assert.notEqual(rotated.id, first.id);
});

test("turn cap rotates the session", () => {
  const { m } = manager();
  const first = m.acquire("repl", "codex");
  for (let i = 0; i < SESSION_MAX_TURNS; i += 1) m.markUsed("repl", "codex");
  const rotated = m.acquire("repl", "codex");
  assert.equal(rotated.fresh, true);
  assert.notEqual(rotated.id, first.id);
});

test("surfaces and providers are isolated; reset clears only the target", () => {
  const { m } = manager();
  const replClaude = m.acquire("repl", "claude");
  const replCodex = m.acquire("repl", "codex");
  const dash = m.acquire("dashboard", "claude");
  assert.equal(new Set([replClaude.id, replCodex.id, dash.id]).size, 3);
  m.markUsed("repl", "claude"); m.markUsed("repl", "codex"); m.markUsed("dashboard", "claude");
  m.reset("repl", "claude");
  assert.equal(m.acquire("repl", "claude").fresh, true);
  assert.equal(m.acquire("repl", "codex").fresh, false);
  assert.equal(m.acquire("dashboard", "claude").fresh, false);
});

test("cross-process safety: writes re-read the file (no cache clobber)", () => {
  const { m, file } = manager();
  m.acquire("repl", "claude");
  // A second manager instance (another process) adds a different surface.
  const other = new SessionManager(file);
  other.acquire("workflow:worklog", "claude");
  m.markUsed("repl", "claude");
  const all = new SessionManager(file).list();
  assert.equal(all.length, 2, "markUsed must not clobber the other process's session");
});

test("sessionArgs maps create vs resume per provider", () => {
  assert.deepEqual(sessionArgs("claude", { id: "abc", fresh: true }).claudeArgs, ["--session-id", "abc"]);
  assert.deepEqual(sessionArgs("claude", { id: "abc", fresh: false }).claudeArgs, ["--resume", "abc"]);
  assert.deepEqual(sessionArgs("codex", { id: "abc", fresh: true }).codexSubcommand, []);
  assert.deepEqual(sessionArgs("codex", { id: "abc", fresh: false }).codexSubcommand, ["resume", "abc"]);
});
