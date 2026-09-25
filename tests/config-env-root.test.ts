import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import dotenv from "dotenv";
import { setActiveProfile } from "../src/profile.ts";

/**
 * Regression test for "Kelly commands other than `start` read `.env` from the current
 * directory" (running a command from another folder silently fell back to defaults).
 * `loadConfig()` must root-anchor to the repo `.env` for EVERY profile, not just Henry,
 * so the resolved path never depends on `process.cwd()`.
 *
 * This never touches the owner's real `.env`: it only spies on `dotenv.config`'s call
 * arguments (the `path` option), it never lets the spy call through to the real
 * filesystem-reading implementation, and it restores both `dotenv.config` and `cwd`
 * in `finally`.
 */
test("loadConfig root-anchors the repo .env for the kelly profile too, independent of cwd", async () => {
  const originalCwd = process.cwd();
  const originalDotenvConfig = dotenv.config;
  const calls: Array<{ path?: string } | undefined> = [];
  const savedIsolation = process.env.HENRY_TEST_ISOLATION;
  try {
    // Never actually read any file — just record what path each call was given.
    (dotenv as unknown as { config: typeof dotenv.config }).config = ((options?: { path?: string }) => {
      calls.push(options);
      return { parsed: {} };
    }) as typeof dotenv.config;

    delete process.env.HENRY_TEST_ISOLATION;
    process.chdir(os.tmpdir());
    setActiveProfile("kelly");

    // Cache-bust so this test gets a fresh module instance with envLoaded=false,
    // regardless of what earlier test files already triggered.
    const configModule = await import(`../src/config.ts?kelly-root-anchor=${Date.now()}-${Math.random()}`);
    configModule.loadConfig();

    const repoRoot = path.resolve(path.dirname(new URL("../src/config.ts", import.meta.url).pathname), "..");
    const rootAnchoredCall = calls.find((call) => call?.path === path.join(repoRoot, ".env"));
    assert.ok(
      rootAnchoredCall,
      `expected a dotenv.config call anchored to ${path.join(repoRoot, ".env")}, got: ${JSON.stringify(calls)}`,
    );
    // A cwd-only call (no explicit path) is still expected — a cwd .env may still win
    // for an explicitly set variable, dotenv just never overrides one that is already set.
    assert.ok(calls.some((call) => call === undefined || call?.path === undefined));
  } finally {
    (dotenv as unknown as { config: typeof dotenv.config }).config = originalDotenvConfig;
    process.chdir(originalCwd);
    setActiveProfile("henry");
    if (savedIsolation === undefined) delete process.env.HENRY_TEST_ISOLATION;
    else process.env.HENRY_TEST_ISOLATION = savedIsolation;
  }
});
