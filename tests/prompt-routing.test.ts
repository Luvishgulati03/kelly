import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HenryAgent } from "../src/agent/henry.ts";
import { loadConfig } from "../src/config.ts";
import type { ActivityLog } from "../src/activity.ts";
import type { HenryMemory } from "../src/memory/engram.ts";

test("Codex and Claude receive the same complete prompt contract for substantive work", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "henry-prompt-routing-"));
  await fs.writeFile(path.join(root, "soul.md"), "Soul contract stays present.", "utf8");
  await fs.writeFile(path.join(root, "personality.md"), "Personality stays present.", "utf8");
  const memory = { context: async () => "" } as unknown as HenryMemory;
  const activity = { record: async () => undefined } as unknown as ActivityLog;
  const agent = new HenryAgent(loadConfig(root), activity, memory);

  const claude = await agent.buildPrompt("Explain this module", "run-1", true, "claude");
  const codex = await agent.buildPrompt("Explain this module", "run-2", true, "codex");

  // This equality is intentional: model routing may choose a different Codex
  // reasoning tier, but it must never remove capabilities, safety rails, soul,
  // personality, memory, or RAG context from a substantive Codex turn.
  assert.equal(codex, claude);
  for (const fullContractInstruction of [
    /standup status\|discover/,
    /Engineering workflow/,
    /Never send or reply to an email without Luvish's explicit approval/,
    /dashboard loopback-only/,
    /knowledge\.db.*never committed or pushed/,
    /delegate only independent investigation in parallel/,
    /Soul contract stays present/,
    /Personality stays present/,
  ]) assert.match(codex, fullContractInstruction);
});
