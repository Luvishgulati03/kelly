import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setActiveProfile } from "../src/profile.ts";
import { createUser, verifyLogin, listUsers, issueSession, readSession, clearedSessionCookie, sessionCookieName } from "../src/dashboard/auth.ts";

// A Kelly started with KELLY_DATA_DIR (every demo) must check logins against that data dir's
// dashboard.db, not the repo default: the owner created accounts with `--demo boutique`, the
// running demo looked elsewhere, and every password read as wrong.
test("Kelly's login database follows KELLY_DATA_DIR before HENRY_DATA_DIR", () => {
  const saved = { KELLY_DATA_DIR: process.env.KELLY_DATA_DIR, HENRY_DATA_DIR: process.env.HENRY_DATA_DIR };
  const demoDir = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-demo-data-"));
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-other-data-"));
  setActiveProfile("kelly");
  try {
    process.env.KELLY_DATA_DIR = demoDir;
    process.env.HENRY_DATA_DIR = otherDir;
    createUser({ username: "counter", password: "counter-password-1", role: "counter" });
    assert.ok(fs.existsSync(path.join(demoDir, "dashboard", "dashboard.db")), "written under KELLY_DATA_DIR");
    assert.ok(!fs.existsSync(path.join(otherDir, "dashboard", "dashboard.db")), "nothing written under HENRY_DATA_DIR");
    assert.ok(verifyLogin("counter", "counter-password-1"), "the account is found where it was created");
    assert.deepEqual(listUsers().map((u) => u.username), ["counter"]);
  } finally {
    if (saved.KELLY_DATA_DIR === undefined) delete process.env.KELLY_DATA_DIR; else process.env.KELLY_DATA_DIR = saved.KELLY_DATA_DIR;
    if (saved.HENRY_DATA_DIR === undefined) delete process.env.HENRY_DATA_DIR; else process.env.HENRY_DATA_DIR = saved.HENRY_DATA_DIR;
  }
});

// The session cookie is named after the active profile: a Kelly browser session never looks
// like Henry's. The old Kelly cookie name is not accepted (existing sessions log in again).
test("session cookie name follows the active profile (kelly_sess / henry_sess)", () => {
  const saved = process.env.KELLY_DATA_DIR;
  process.env.KELLY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-cookie-data-"));
  try {
    setActiveProfile("henry");
    assert.equal(sessionCookieName(), "henry_sess");
    setActiveProfile("kelly");
    assert.equal(sessionCookieName(), "kelly_sess");
    createUser({ username: "admin", password: "admin-password-1", role: "admin" });
    const user = verifyLogin("admin", "admin-password-1");
    assert.ok(user);
    const { cookie } = issueSession(user!);
    assert.match(cookie, /^kelly_sess=/);
    assert.match(clearedSessionCookie(), /^kelly_sess=;/);
    const value = cookie.split(";")[0].slice("kelly_sess=".length);
    assert.equal(readSession(`kelly_sess=${value}`)?.username, "admin");
    assert.equal(readSession(`henry_sess=${value}`), undefined);
  } finally {
    if (saved === undefined) delete process.env.KELLY_DATA_DIR; else process.env.KELLY_DATA_DIR = saved;
  }
});
