import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { HenryMemory } from "../src/memory/engram.ts";

test("HenryMemory adds and recalls a memory through the real Engram database", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-engram-"));
  const config = loadConfig(rootDir);
  await fs.mkdir(config.dataDir, { recursive: true });
  const activity = new ActivityLog(config.activityPath);
  const memory = new HenryMemory(config, activity);

  try {
    await activity.init();
    await memory.init();

    const id = await memory.remember(
      "Luvish prefers Codex-first terminal workflows for building Henry.",
      { source: "captured/test-preferences.md", metadata: { test: true } },
    );
    const results = await memory.recall("Which terminal workflow does Luvish prefer for Henry?", 5);

    assert.ok(results.some((result) => result.id === id));
    assert.match(results.find((result) => result.id === id)?.content || "", /Codex-first/);
    assert.equal(memory.engine.stats().dbPath, config.dbPath);
    assert.equal(memory.engine.stats().count, 1);
    await fs.access(config.dbPath);
    await fs.access(path.join(config.memoryDir, "captured/test-preferences.md"));
  } finally {
    memory.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("embedding-provider marker: a mismatch warns without self-silencing; only index --fresh advances it", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-engram-marker-"));
  const config = loadConfig(rootDir);
  await fs.mkdir(config.dataDir, { recursive: true });
  const activity = new ActivityLog(config.activityPath);
  const markerPath = path.join(config.dataDir, ".memory-embedding");

  const first = new HenryMemory(config, activity);
  try {
    await activity.init();
    await first.init();
    await first.remember("Marker fixture memory.", { source: "captured/marker-fixture.md" });
  } finally { first.close(); }

  // Simulate a provider migration: memories exist, marker names the OLD provider.
  await fs.writeFile(markerPath, "legacy-hash-provider", "utf8");

  const second = new HenryMemory(config, activity);
  try {
    await second.init();
    assert.equal(
      (await fs.readFile(markerPath, "utf8")).trim(), "legacy-hash-provider",
      "a mismatched marker must survive startup — overwriting it would silence the warning after one boot",
    );
    await second.index(true);
    assert.equal(
      (await fs.readFile(markerPath, "utf8")).trim(), second.engine.embedding.name,
      "a --fresh reindex re-embeds everything, so the marker advances to the active provider",
    );
  } finally {
    second.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
