import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import {
  REQUIRED_GMAIL_SCOPES,
  classifyRefreshError,
  formatGmailDoctorReport,
  runGmailDoctor,
  safeGmailDoctor,
} from "../src/integrations/gmail-doctor.ts";

test("Gmail doctor reports a healthy setup without exposing OAuth secrets", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-gmail-doctor-"));
  const config = loadConfig(rootDir);
  const clientSecret = "client-secret-that-must-not-leak";
  const refreshToken = "refresh-token-that-must-not-leak";
  const files = new Map([
    [config.gmailCredentialsPath, JSON.stringify({ installed: {
      client_id: "client-id",
      client_secret: clientSecret,
      redirect_uris: [config.gmailRedirectUri],
    } })],
    [config.gmailTokenPath, JSON.stringify({
      refresh_token: refreshToken,
      access_token: "access-token",
      expiry_date: 2_000_000,
      scope: REQUIRED_GMAIL_SCOPES.join(" "),
    })],
  ]);
  let refreshInput: { clientId: string; clientSecret: string; redirectUri: string; refreshToken: string } | undefined;
  const report = await runGmailDoctor(config, {
    readFile: async (filePath) => files.get(filePath) || (() => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); })(),
    now: () => 1_000_000,
    refresh: async (input) => {
      refreshInput = input;
      return { ok: true, scope: REQUIRED_GMAIL_SCOPES.join(" "), expiryDate: 2_000_000 };
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.checks.every((check) => check.status === "ok"), true);
  assert.deepEqual(refreshInput, {
    clientId: "client-id", clientSecret, redirectUri: config.gmailRedirectUri, refreshToken,
  });
  const output = formatGmailDoctorReport(report);
  assert.doesNotMatch(output, /client-secret-that-must-not-leak/);
  assert.doesNotMatch(output, /refresh-token-that-must-not-leak/);
  assert.match(output, /Gmail doctor — Gmail is healthy\./);
});

test("Gmail doctor skips refresh when local files are missing and gives remediation", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-gmail-doctor-missing-"));
  const config = loadConfig(rootDir);
  let refreshCalled = false;
  const report = await runGmailDoctor(config, {
    readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    refresh: async () => { refreshCalled = true; return { ok: true }; },
  });

  assert.equal(report.ok, false);
  assert.equal(refreshCalled, false);
  assert.equal(report.checks.find((check) => check.id === "credentials")?.status, "fail");
  assert.equal(report.checks.find((check) => check.id === "token")?.status, "fail");
  assert.match(formatGmailDoctorReport(report), /henry gmail auth/);
});

test("refresh failures are classified without echoing raw error text", () => {
  assert.deepEqual(classifyRefreshError(new Error("invalid_grant: refresh token revoked")), {
    reason: "invalid_grant",
    message: "Google rejected the refresh token (invalid_grant).",
  });
  assert.deepEqual(classifyRefreshError(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })), {
    reason: "network",
    message: "Could not reach Google's token endpoint.",
  });
});

test("runGmailDoctor reports a revoked refresh token as invalid_grant", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-gmail-doctor-invalid-grant-"));
  const config = loadConfig(rootDir);
  const files = new Map([
    [config.gmailCredentialsPath, JSON.stringify({ installed: {
      client_id: "client-id", client_secret: "client-secret", redirect_uris: [config.gmailRedirectUri],
    } })],
    [config.gmailTokenPath, JSON.stringify({
      refresh_token: "refresh-token", access_token: "access-token", expiry_date: 2_000_000,
      scope: REQUIRED_GMAIL_SCOPES.join(" "),
    })],
  ]);
  const report = await runGmailDoctor(config, {
    readFile: async (filePath) => files.get(filePath) || "",
    now: () => 1_000_000,
    refresh: async () => ({
      ok: false, reason: "invalid_grant", message: "Google rejected the refresh token (invalid_grant).",
    }),
  });

  const refresh = report.checks.find((check) => check.id === "refresh");
  assert.equal(report.ok, false);
  assert.equal(refresh?.status, "fail");
  assert.match(refresh?.detail || "", /invalid_grant/);
  assert.match(refresh?.nextStep || "", /re-authorise/);
});

test("runGmailDoctor reports missing required scopes even when refresh succeeds", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-gmail-doctor-missing-scopes-"));
  const config = loadConfig(rootDir);
  const grantedScope = REQUIRED_GMAIL_SCOPES[0];
  const files = new Map([
    [config.gmailCredentialsPath, JSON.stringify({ installed: {
      client_id: "client-id", client_secret: "client-secret", redirect_uris: [config.gmailRedirectUri],
    } })],
    [config.gmailTokenPath, JSON.stringify({
      refresh_token: "refresh-token", access_token: "access-token", expiry_date: 2_000_000,
      scope: grantedScope,
    })],
  ]);
  const report = await runGmailDoctor(config, {
    readFile: async (filePath) => files.get(filePath) || "",
    now: () => 1_000_000,
    refresh: async () => ({ ok: true, scope: grantedScope, expiryDate: 2_000_000 }),
  });

  const scopes = report.checks.find((check) => check.id === "scopes");
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.id === "refresh")?.status, "ok");
  assert.equal(scopes?.status, "fail");
  assert.match(scopes?.detail || "", /gmail\.send/);
  assert.match(scopes?.nextStep || "", /approve every requested permission/);
});

test("safe Gmail doctor turns unexpected failures into a redacted report", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-gmail-doctor-safe-"));
  const config = loadConfig(rootDir);
  const report = await safeGmailDoctor(config, { now: () => { throw new Error("refresh_token=secret"); } });
  assert.equal(report.ok, false);
  assert.match(report.summary, /failed to complete/);
  assert.doesNotMatch(JSON.stringify(report), /refresh_token=secret/);
});
