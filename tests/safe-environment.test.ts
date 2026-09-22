import test from "node:test";
import assert from "node:assert/strict";
import { setActiveProfile } from "../src/profile.ts";
import { safeEnvironment } from "../src/util/env.ts";

test("provider subprocesses see the profile's data location but never its tokens", () => {
  setActiveProfile("kelly");
  const saved = { ...process.env };
  try {
    process.env.AGENT_PROFILE = "kelly";
    process.env.KELLY_DATA_DIR = "/tmp/kelly-data";
    process.env.KELLY_TRADE = "boutique";
    process.env.KELLY_TELEGRAM_BOT_TOKEN = "bot-secret";
    process.env.KELLY_DASHBOARD_TOKEN = "dash-secret";
    process.env.KELLY_KOKORO_TOKEN = "tts-secret";
    const env = safeEnvironment("codex");
    assert.equal(env.AGENT_PROFILE, "kelly");
    assert.equal(env.KELLY_DATA_DIR, "/tmp/kelly-data");
    assert.equal(env.KELLY_TRADE, "boutique");
    for (const key of ["KELLY_TELEGRAM_BOT_TOKEN", "KELLY_DASHBOARD_TOKEN", "KELLY_KOKORO_TOKEN"]) assert.equal(env[key], undefined, `${key} must not reach the model's shell`);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
