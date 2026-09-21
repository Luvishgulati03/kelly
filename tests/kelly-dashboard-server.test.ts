import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HenryRuntime } from "../src/runtime.ts";
import { localAdminBypassEnabled } from "../src/dashboard/server.ts";

/** Minimal fake — localAdminBypassEnabled only ever reads runtime.config.settingsPath. */
function fakeRuntime(settingsPath: string): HenryRuntime {
  return { config: { settingsPath } } as unknown as HenryRuntime;
}

function withSettingsFile(contents: string | undefined, run: (settingsPath: string) => void): void {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-bypass-"));
  const settingsPath = path.join(tempRoot, "settings.json");
  if (contents !== undefined) fs.writeFileSync(settingsPath, contents, "utf8");
  run(settingsPath);
}

test("localAdminBypassEnabled: defaults to enabled when settings.json is absent", () => {
  withSettingsFile(undefined, (settingsPath) => {
    assert.equal(localAdminBypassEnabled(fakeRuntime(settingsPath)), true);
  });
});

test("localAdminBypassEnabled: a malformed settings.json (a bare JSON string) must NOT be treated as an object and must fall back to the default, not silently enable via an unchecked cast", () => {
  // "claude" is valid JSON but not a settings record — this is exactly the shape that used
  // to slip through the old unchecked `as Record<string, unknown>` cast in server.ts.
  withSettingsFile('"claude"', (settingsPath) => {
    assert.equal(localAdminBypassEnabled(fakeRuntime(settingsPath)), true, "malformed settings must fall back to the safe default, not throw or misread");
  });
});

test("localAdminBypassEnabled: a bare JSON array is also not a settings record and falls back to the default", () => {
  withSettingsFile("[1,2,3]", (settingsPath) => {
    assert.equal(localAdminBypassEnabled(fakeRuntime(settingsPath)), true);
  });
});

test("localAdminBypassEnabled: honours the flat dotted key", () => {
  withSettingsFile(JSON.stringify({ "dashboard.auth.localAdminBypass": false }), (settingsPath) => {
    assert.equal(localAdminBypassEnabled(fakeRuntime(settingsPath)), false);
  });
});

test("localAdminBypassEnabled: honours the nested shape", () => {
  withSettingsFile(JSON.stringify({ dashboard: { auth: { localAdminBypass: false } } }), (settingsPath) => {
    assert.equal(localAdminBypassEnabled(fakeRuntime(settingsPath)), false);
  });
});

test("localAdminBypassEnabled: an empty object keeps the default (true)", () => {
  withSettingsFile("{}", (settingsPath) => {
    assert.equal(localAdminBypassEnabled(fakeRuntime(settingsPath)), true);
  });
});
