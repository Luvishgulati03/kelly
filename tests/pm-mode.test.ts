import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HenryRuntime } from "../src/runtime.ts";

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "henry-pm-"));
  fs.cpSync(path.join(process.cwd(), "workflows"), path.join(root, "workflows"), { recursive: true });
  return root;
}

test("pm mode: persists across runtimes and rewrites the prompt contract", async () => {
  const root = tempRoot();
  const runtime = await HenryRuntime.create(root);

  assert.equal(runtime.config.pmMode, false, "off by default");
  const offPrompt = await runtime.agent.buildPrompt("plan the beta launch project", "run-1", true);
  assert.doesNotMatch(offPrompt, /PM MODE IS ON/);

  await runtime.setPmMode(true);
  const onPrompt = await runtime.agent.buildPrompt("plan the beta launch project", "run-2", true);
  assert.match(onPrompt, /PM MODE IS ON/);
  assert.match(onPrompt, /DECISION \(one line\) · WHY/, "the decision contract must be spelled out");
  assert.match(onPrompt, /memory remember/, "decision-log instruction present");

  // Resumed (slim) turns still restate the contract — sessions may span a toggle.
  const resumedPrompt = await runtime.agent.buildPrompt("re-plan sprint 2", "run-3", false);
  assert.match(resumedPrompt, /PM MODE IS ON/);
  runtime.close();

  // A fresh process (new runtime over the same root) must come up with PM mode still on.
  const second = await HenryRuntime.create(root);
  assert.equal(second.config.pmMode, true, "pmMode persists via settings.json");
  await second.setPmMode(false);
  assert.equal(second.config.pmMode, false);
  second.close();
});
