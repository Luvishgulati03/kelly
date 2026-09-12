import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager, SESSION_MAX_TURNS } from "../src/providers/session.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "henry-sessions-"));
}

test("a restarted process resumes the same provider session", () => {
  const dir = tempDir();
  const jsonPath = path.join(dir, "sessions.json");

  const first = new SessionManager(jsonPath);
  const created = first.acquire("repl", "codex");
  assert.equal(created.fresh, true);
  first.updateId("repl", "codex", "thread-real-123"); // codex minted its real thread id
  first.markUsed("repl", "codex");
  first.close(); // process dies — disconnect

  const second = new SessionManager(jsonPath); // orchestrator restarts
  const resumed = second.acquire("repl", "codex");
  assert.equal(resumed.fresh, false, "restart must RESUME, not recreate");
  assert.equal(resumed.id, "thread-real-123", "must resume the provider's real session id");
  second.close();
});

test("legacy sessions.json migrates once into sqlite and is parked", () => {
  const dir = tempDir();
  const jsonPath = path.join(dir, "sessions.json");
  const legacy = {
    "repl::claude": {
      id: "legacy-abc", provider: "claude", surface: "repl",
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), turns: 3,
    },
  };
  fs.writeFileSync(jsonPath, JSON.stringify(legacy));

  const manager = new SessionManager(jsonPath);
  const acquired = manager.acquire("repl", "claude");
  assert.equal(acquired.fresh, false);
  assert.equal(acquired.id, "legacy-abc");
  assert.equal(fs.existsSync(jsonPath), false, "legacy file parked");
  assert.equal(fs.existsSync(`${jsonPath}.migrated`), true);
  manager.close();
});

test("staleness and turn caps still force fresh sessions", () => {
  const dir = tempDir();
  const manager = new SessionManager(path.join(dir, "sessions.json"));
  const created = manager.acquire("luna::architect", "codex");
  for (let i = 0; i < SESSION_MAX_TURNS; i++) manager.markUsed("luna::architect", "codex");
  const recreated = manager.acquire("luna::architect", "codex");
  assert.equal(recreated.fresh, true, "turn cap must expire the session");
  assert.notEqual(recreated.id, created.id);

  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  manager.acquire("telegram", "claude", old);
  const afterStale = manager.acquire("telegram", "claude");
  assert.equal(afterStale.fresh, true, "2h staleness must expire the session");
  manager.close();
});

test("reset clears one provider or a whole surface", () => {
  const dir = tempDir();
  const manager = new SessionManager(path.join(dir, "sessions.json"));
  manager.acquire("repl", "codex");
  manager.acquire("repl", "claude");
  manager.reset("repl", "codex");
  assert.equal(manager.list().length, 1);
  manager.reset("repl");
  assert.equal(manager.list().length, 0);
  manager.close();
});
