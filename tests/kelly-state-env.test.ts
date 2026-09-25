import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error JavaScript launcher intentionally has no build step.
import { applyKellyStateEnv, resolveStateDir } from "../bin/kelly-env.mjs";

const roots: string[] = [];
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function repoWithEnv(contents?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-state-env-"));
  roots.push(root);
  if (contents !== undefined) fs.writeFileSync(path.join(root, ".env"), contents);
  return root;
}

test("kelly launcher: a repo .env KELLY_DATA_DIR / KELLY_MEMORY_DIR is honoured (second install on one Mac)", () => {
  const root = repoWithEnv("KELLY_DATA_DIR=/tmp/x\nKELLY_MEMORY_DIR=/tmp/x-memory\n");
  const env = applyKellyStateEnv({ root, env: {}, homedir: "/home/test" });
  assert.equal(env.KELLY_DATA_DIR, "/tmp/x");
  assert.equal(env.KELLY_MEMORY_DIR, "/tmp/x-memory");
});

test("kelly launcher: an exported shell value beats the repo .env", () => {
  const root = repoWithEnv("KELLY_DATA_DIR=/tmp/x\nKELLY_MEMORY_DIR=/tmp/x-memory\n");
  const env = applyKellyStateEnv({ root, env: { KELLY_DATA_DIR: "/srv/shell-data" }, homedir: "/home/test" });
  assert.equal(env.KELLY_DATA_DIR, "/srv/shell-data");
  assert.equal(env.KELLY_MEMORY_DIR, "/tmp/x-memory");
});

test("kelly launcher: unset in both falls back to ~/.kelly (the existing install's location)", () => {
  const root = repoWithEnv("KELLY_TRADE=boutique\n");
  const env = applyKellyStateEnv({ root, env: {}, homedir: "/home/test" });
  assert.equal(env.KELLY_DATA_DIR, path.join("/home/test", ".kelly", "data"));
  assert.equal(env.KELLY_MEMORY_DIR, path.join("/home/test", ".kelly", "memory"));
  const noEnvFile = applyKellyStateEnv({ root: repoWithEnv(), env: {}, homedir: "/home/test" });
  assert.equal(noEnvFile.KELLY_DATA_DIR, path.join("/home/test", ".kelly", "data"));
});

test("kelly launcher: ~ expands to the home directory and relative paths resolve from the repository root", () => {
  assert.equal(resolveStateDir("~/.kelly-second/data", "/repo", "/home/test"), "/home/test/.kelly-second/data");
  assert.equal(resolveStateDir("~", "/repo", "/home/test"), "/home/test");
  assert.equal(resolveStateDir("state/data", "/repo", "/home/test"), "/repo/state/data");
  const root = repoWithEnv("KELLY_DATA_DIR=~/.kelly-second/data\n");
  assert.equal(applyKellyStateEnv({ root, env: {}, homedir: "/home/test" }).KELLY_DATA_DIR, "/home/test/.kelly-second/data");
});

test("kelly launcher: with dotenv loading off (test isolation) the repo .env is never read", () => {
  const root = repoWithEnv("KELLY_DATA_DIR=/tmp/x\n");
  const env = applyKellyStateEnv({ root, env: {}, homedir: "/home/test", loadDotenv: false });
  assert.equal(env.KELLY_DATA_DIR, path.join("/home/test", ".kelly", "data"));
});
