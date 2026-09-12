/**
 * `henry gmail doctor` — a read-only diagnostic for the Gmail OAuth setup.
 *
 * A broken Gmail setup used to surface as a raw throw from `GmailService.oauth()`, which
 * tells Luvish nothing actionable. This reports every failure mode with a next step, is
 * strictly read-only (it NEVER sends a test email — the outbound approval gate is
 * sacred), NEVER throws, and NEVER prints a token, client secret, or refresh token.
 */
import fs from "node:fs/promises";
import type { HenryConfig } from "../config.ts";

/** The scopes Henry actually needs. Kept in sync with `SCOPES` in `gmail.ts`. */
export const REQUIRED_GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

export type GmailDoctorStatus = "ok" | "warn" | "fail" | "skipped";

export interface GmailDoctorCheck {
  id: "credentials" | "token" | "expiry" | "refresh" | "scopes" | "redirect";
  label: string;
  status: GmailDoctorStatus;
  detail: string;
  /** What Luvish should do about it. Always present when status is not "ok". */
  nextStep?: string;
}

export interface GmailDoctorReport {
  ok: boolean;
  generatedAt: string;
  summary: string;
  credentialsPath: string;
  tokenPath: string;
  checks: GmailDoctorCheck[];
}

/** Outcome of a real token refresh, reduced to non-secret facts. */
export interface GmailRefreshProbeResult {
  ok: boolean;
  /** "invalid_grant" (revoked/expired), "network", "permission", or "unknown". */
  reason?: "invalid_grant" | "network" | "permission" | "unknown";
  message?: string;
  scope?: string;
  expiryDate?: number;
}

export interface GmailDoctorDeps {
  readFile?: (filePath: string) => Promise<string>;
  /** Injected so tests never hit the network. Receives no secrets it does not already need. */
  refresh?: (input: {
    clientId: string; clientSecret: string; redirectUri: string; refreshToken: string;
  }) => Promise<GmailRefreshProbeResult>;
  now?: () => number;
}

/** Never let a raw error string leak a token: classify it, then report the class. */
export function classifyRefreshError(error: unknown): { reason: NonNullable<GmailRefreshProbeResult["reason"]>; message: string } {
  const raw = error instanceof Error ? `${error.message}` : String(error);
  const code = (error as { code?: string })?.code || "";
  const text = `${raw} ${code}`.toLowerCase();
  if (text.includes("invalid_grant")) return { reason: "invalid_grant", message: "Google rejected the refresh token (invalid_grant)." };
  if (/enotfound|econnrefused|etimedout|econnreset|eai_again|network|fetch failed|socket hang up|getaddrinfo/.test(text)) {
    return { reason: "network", message: "Could not reach Google's token endpoint." };
  }
  if (/insufficient|forbidden|permission|access_denied|unauthorized_client|403/.test(text)) {
    return { reason: "permission", message: "Google refused the refresh for a permission/consent reason." };
  }
  return { reason: "unknown", message: "The refresh failed for an unrecognised reason." };
}

/** The real refresh probe. Kept out of `runGmailDoctor` so tests can replace it wholesale. */
async function liveRefresh(input: {
  clientId: string; clientSecret: string; redirectUri: string; refreshToken: string;
}): Promise<GmailRefreshProbeResult> {
  try {
    const { google } = await import("googleapis");
    const client = new google.auth.OAuth2(input.clientId, input.clientSecret, input.redirectUri);
    client.setCredentials({ refresh_token: input.refreshToken });
    const refreshed = await client.refreshAccessToken();
    return {
      ok: true,
      scope: refreshed.credentials.scope,
      expiryDate: refreshed.credentials.expiry_date ?? undefined,
    };
  } catch (error) {
    const classified = classifyRefreshError(error);
    return { ok: false, reason: classified.reason, message: classified.message };
  }
}

function parseJson(raw: string): { value?: Record<string, unknown>; error?: string } {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "the file is not a JSON object" };
    return { value: value as Record<string, unknown> };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "unparseable JSON" };
  }
}

function stringField(source: Record<string, unknown> | undefined, key: string): string {
  const value = source?.[key];
  return typeof value === "string" ? value : "";
}

/**
 * Runs every check and returns the structured report. It resolves even if everything is
 * broken; the only way it can throw is a bug, so the whole body is additionally wrapped.
 */
export async function runGmailDoctor(config: HenryConfig, deps: GmailDoctorDeps = {}): Promise<GmailDoctorReport> {
  const readFile = deps.readFile || ((filePath: string) => fs.readFile(filePath, "utf8"));
  const refresh = deps.refresh || liveRefresh;
  const now = deps.now || (() => Date.now());
  const checks: GmailDoctorCheck[] = [];
  const authHint = "Run: henry gmail auth";

  let clientId = "";
  let clientSecret = "";
  let redirectUris: string[] = [];

  // 1. Credentials file.
  try {
    const raw = await readFile(config.gmailCredentialsPath);
    const parsed = parseJson(raw);
    if (!parsed.value) {
      checks.push({
        id: "credentials", label: "OAuth client credentials", status: "fail",
        detail: `${config.gmailCredentialsPath} is not valid JSON (${parsed.error}).`,
        nextStep: "Re-download the Desktop-app OAuth JSON from Google Cloud Console and save it at that path.",
      });
    } else {
      const block = (parsed.value.installed || parsed.value.web || parsed.value) as Record<string, unknown>;
      clientId = stringField(block, "client_id");
      clientSecret = stringField(block, "client_secret");
      redirectUris = Array.isArray(block.redirect_uris) ? block.redirect_uris.filter((item): item is string => typeof item === "string") : [];
      const missing = [!clientId && "client_id", !clientSecret && "client_secret"].filter(Boolean) as string[];
      checks.push(missing.length
        ? {
            id: "credentials", label: "OAuth client credentials", status: "fail",
            detail: `${config.gmailCredentialsPath} is missing: ${missing.join(", ")}.`,
            nextStep: "Create OAuth 2.0 credentials of type 'Desktop app' in Google Cloud Console and save that JSON at that path.",
          }
        : {
            id: "credentials", label: "OAuth client credentials", status: "ok",
            detail: `Readable at ${config.gmailCredentialsPath}; client_id and client_secret present (values redacted).`,
          });
    }
  } catch (error) {
    const missing = (error as { code?: string })?.code === "ENOENT";
    checks.push({
      id: "credentials", label: "OAuth client credentials", status: "fail",
      detail: missing
        ? `No credentials file at ${config.gmailCredentialsPath}.`
        : `Cannot read ${config.gmailCredentialsPath} (${(error as { code?: string })?.code || "read error"}).`,
      nextStep: missing
        ? "Enable the Gmail API, create 'Desktop app' OAuth credentials in Google Cloud Console, and save the JSON at that path."
        : "Fix the file permissions on that path (Henry expects it readable by its own user).",
    });
  }

  // 2. Token file.
  let token: Record<string, unknown> | undefined;
  let refreshToken = "";
  try {
    const raw = await readFile(config.gmailTokenPath);
    const parsed = parseJson(raw);
    if (!parsed.value) {
      checks.push({
        id: "token", label: "Stored OAuth token", status: "fail",
        detail: `${config.gmailTokenPath} is not valid JSON (${parsed.error}).`,
        nextStep: `Delete that file and re-authorise. ${authHint}`,
      });
    } else {
      token = parsed.value;
      refreshToken = stringField(token, "refresh_token");
      checks.push(refreshToken
        ? {
            id: "token", label: "Stored OAuth token", status: "ok",
            detail: `Readable at ${config.gmailTokenPath}; a refresh_token is present (value redacted).`,
          }
        : {
            id: "token", label: "Stored OAuth token", status: "fail",
            detail: `${config.gmailTokenPath} has no refresh_token, so Henry cannot renew access on its own.`,
            nextStep: `Re-authorise with offline consent so Google issues a refresh token. ${authHint}`,
          });
    }
  } catch (error) {
    const missing = (error as { code?: string })?.code === "ENOENT";
    checks.push({
      id: "token", label: "Stored OAuth token", status: "fail",
      detail: missing ? `Gmail is not connected — no token at ${config.gmailTokenPath}.` : `Cannot read ${config.gmailTokenPath}.`,
      nextStep: authHint,
    });
  }

  // 3. Expiry state.
  if (!token) {
    checks.push({ id: "expiry", label: "Access-token expiry", status: "skipped", detail: "No token file to inspect.", nextStep: authHint });
  } else {
    const expiry = typeof token.expiry_date === "number" ? token.expiry_date : undefined;
    if (expiry === undefined) {
      checks.push({
        id: "expiry", label: "Access-token expiry", status: "warn",
        detail: "The token has no expiry_date, so Henry cannot tell how fresh it is.",
        nextStep: "Harmless if the refresh check below passes; otherwise re-authorise.",
      });
    } else {
      const remainingMs = expiry - now();
      const minutes = Math.round(remainingMs / 60_000);
      if (remainingMs <= 0) {
        checks.push({
          id: "expiry", label: "Access-token expiry", status: "warn",
          detail: `The access token expired ${Math.abs(minutes)} minute(s) ago.`,
          nextStep: "Normal — Henry refreshes on demand. Only act if the refresh check below fails.",
        });
      } else if (remainingMs <= 5 * 60_000) {
        checks.push({ id: "expiry", label: "Access-token expiry", status: "warn", detail: `The access token expires in ${minutes} minute(s).`, nextStep: "No action needed; Henry refreshes automatically." });
      } else {
        checks.push({ id: "expiry", label: "Access-token expiry", status: "ok", detail: `The access token is valid for another ${minutes} minute(s).` });
      }
    }
  }

  // 4. Does a refresh actually succeed?
  let refreshResult: GmailRefreshProbeResult | undefined;
  if (!clientId || !clientSecret || !refreshToken) {
    checks.push({
      id: "refresh", label: "Token refresh", status: "skipped",
      detail: "Skipped — it needs a client_id, a client_secret, and a refresh_token.",
      nextStep: "Fix the credentials/token checks above first.",
    });
  } else {
    try {
      refreshResult = await refresh({ clientId, clientSecret, redirectUri: config.gmailRedirectUri, refreshToken });
    } catch (error) {
      const classified = classifyRefreshError(error);
      refreshResult = { ok: false, reason: classified.reason, message: classified.message };
    }
    if (refreshResult.ok) {
      checks.push({ id: "refresh", label: "Token refresh", status: "ok", detail: "Google issued a fresh access token (value redacted)." });
    } else {
      const reason = refreshResult.reason || "unknown";
      const nextStep = reason === "invalid_grant"
        ? `Access was revoked or the refresh token expired — re-authorise. ${authHint}`
        : reason === "network"
          ? "Check network/DNS/proxy reachability to oauth2.googleapis.com, then re-run this doctor."
          : reason === "permission"
            ? "Confirm the Gmail API is enabled and the OAuth consent screen lists this account as a test user or is published, then re-authorise."
            : `Re-run with the underlying error visible, then re-authorise if it persists. ${authHint}`;
      checks.push({
        id: "refresh", label: "Token refresh", status: "fail",
        detail: `${refreshResult.message || "Refresh failed."} (${reason})`,
        nextStep,
      });
    }
  }

  // 5. Granted scopes vs what Henry needs.
  const grantedRaw = refreshResult?.scope || stringField(token, "scope");
  const granted = grantedRaw.split(/\s+/).filter(Boolean);
  if (!granted.length) {
    checks.push({
      id: "scopes", label: "Granted scopes", status: token ? "warn" : "skipped",
      detail: token ? "The token records no scopes, so Henry cannot verify its access." : "No token to inspect.",
      nextStep: `Re-authorise to record the granted scopes. ${authHint}`,
    });
  } else {
    const missing = REQUIRED_GMAIL_SCOPES.filter((scope) => !granted.includes(scope));
    checks.push(missing.length
      ? {
          id: "scopes", label: "Granted scopes", status: "fail",
          detail: `Missing scope(s): ${missing.join(", ")}. Granted: ${granted.join(", ")}.`,
          nextStep: `Re-authorise and approve every requested permission. ${authHint}`,
        }
      : { id: "scopes", label: "Granted scopes", status: "ok", detail: `All required scopes granted: ${REQUIRED_GMAIL_SCOPES.join(", ")}.` });
  }

  // 6. Redirect URI Henry will use vs what the client is configured for.
  if (!redirectUris.length) {
    checks.push({
      id: "redirect", label: "Redirect URI", status: "warn",
      detail: `Henry will use ${config.gmailRedirectUri}; the credentials file lists no redirect_uris to compare it against.`,
      nextStep: "Desktop-app clients accept loopback redirects, so this is usually fine. If auth fails, add that exact URI to the client in Google Cloud Console.",
    });
  } else if (redirectUris.includes(config.gmailRedirectUri)) {
    checks.push({ id: "redirect", label: "Redirect URI", status: "ok", detail: `Henry will use ${config.gmailRedirectUri}, which is configured on the OAuth client.` });
  } else {
    checks.push({
      id: "redirect", label: "Redirect URI", status: "warn",
      detail: `Henry will use ${config.gmailRedirectUri}; the OAuth client lists ${redirectUris.join(", ")}.`,
      nextStep: "Either add Henry's URI to the OAuth client, or set GMAIL_REDIRECT_URI to one of the configured values.",
    });
  }

  const failed = checks.filter((check) => check.status === "fail");
  const warned = checks.filter((check) => check.status === "warn");
  return {
    ok: failed.length === 0,
    generatedAt: new Date(now()).toISOString(),
    summary: failed.length
      ? `Gmail is not healthy: ${failed.length} failing check(s) — ${failed.map((check) => check.label).join(", ")}.`
      : warned.length
        ? `Gmail works, with ${warned.length} warning(s).`
        : "Gmail is healthy.",
    credentialsPath: config.gmailCredentialsPath,
    tokenPath: config.gmailTokenPath,
    checks,
  };
}

/** A doctor that crashes is not a doctor: the last-resort wrapper. */
export async function safeGmailDoctor(config: HenryConfig, deps: GmailDoctorDeps = {}): Promise<GmailDoctorReport> {
  try {
    return await runGmailDoctor(config, deps);
  } catch (error) {
    const classified = classifyRefreshError(error);
    return {
      ok: false,
      generatedAt: new Date().toISOString(),
      summary: "The Gmail doctor itself failed to complete.",
      credentialsPath: config.gmailCredentialsPath,
      tokenPath: config.gmailTokenPath,
      checks: [{
        id: "credentials", label: "Gmail doctor", status: "fail",
        detail: classified.message,
        nextStep: "Report this — the diagnostic could not run. Meanwhile, check the credential and token paths by hand.",
      }],
    };
  }
}

/** Human-readable rendering for the terminal. Contains no secrets by construction. */
export function formatGmailDoctorReport(report: GmailDoctorReport): string {
  const marker: Record<GmailDoctorStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL", skipped: "skip" };
  const lines = [`Gmail doctor — ${report.summary}`, ""];
  for (const check of report.checks) {
    lines.push(`[${marker[check.status]}] ${check.label}: ${check.detail}`);
    if (check.nextStep) lines.push(`         -> ${check.nextStep}`);
  }
  return lines.join("\n");
}
