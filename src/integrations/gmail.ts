import fs from "node:fs/promises";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { google, type gmail_v1 } from "googleapis";
import { CodeChallengeMethod } from "google-auth-library";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { ApprovalStore } from "../approval/store.ts";
import type { ApprovalItem } from "../types.ts";
import { assertOutboundExecutionClaim } from "../guardrails.ts";
import { buildRawMessage, toBase64Url } from "./gmail-message.ts";
import { formatGmailDoctorReport, REQUIRED_GMAIL_SCOPES, safeGmailDoctor, type GmailDoctorDeps, type GmailDoctorReport } from "./gmail-doctor.ts";

const SCOPES = REQUIRED_GMAIL_SCOPES;

export interface InboxMessage {
  id: string;
  threadId?: string;
  /**
   * The RFC 5322 `Message-ID` header — NOT gmail's own `id`. Every non-Gmail mail client
   * threads on this via `In-Reply-To`/`References`, so a reply that does not carry it
   * arrives as a brand-new conversation no matter what `threadId` says.
   */
  messageId?: string;
  /** The message's own `References` chain, so a reply can append to it rather than replace it. */
  references?: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;
}

export { formatGmailDoctorReport, type GmailDoctorReport };

function header(message: gmail_v1.Schema$Message, name: string): string {
  return message.payload?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

function decodeBody(value?: string | null): string {
  if (!value) return "";
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function textPart(payload?: gmail_v1.Schema$MessagePart): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodeBody(payload.body.data);
  for (const part of payload.parts || []) {
    const found = textPart(part);
    if (found) return found;
  }
  return payload.body?.data ? decodeBody(payload.body.data) : "";
}

export class GmailService {
  private client?: gmail_v1.Gmail;

  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    private readonly approvals: ApprovalStore,
    /** Test seam only: replaces the authenticated Google client so tests never hit the network. */
    private readonly clientFactory?: () => Promise<gmail_v1.Gmail>,
  ) {}

  private async oauth(): Promise<import("googleapis").Auth.OAuth2Client> {
    let raw: string;
    try { raw = await fs.readFile(this.config.gmailCredentialsPath, "utf8"); }
    catch { throw new Error(`Gmail credentials missing at ${this.config.gmailCredentialsPath}. Run: henry gmail auth`); }
    const credentials = JSON.parse(raw) as Record<string, Record<string, string>>;
    const config = credentials.installed || credentials.web || credentials;
    const client = new google.auth.OAuth2(config.client_id, config.client_secret, this.config.gmailRedirectUri);
    try { await fs.access(this.config.gmailTokenPath); client.setCredentials(JSON.parse(await fs.readFile(this.config.gmailTokenPath, "utf8"))); }
    catch { throw new Error(`Gmail is not connected. Run: henry gmail auth`); }
    return client;
  }

  private async api(): Promise<gmail_v1.Gmail> {
    if (this.client) return this.client;
    this.client = this.clientFactory ? await this.clientFactory() : google.gmail({ version: "v1", auth: await this.oauth() });
    return this.client;
  }

  /**
   * `henry gmail doctor` — read-only OAuth diagnostics. Never sends anything, never
   * throws, and never returns a token, client secret, or refresh token.
   */
  async doctor(deps?: GmailDoctorDeps): Promise<GmailDoctorReport> {
    return safeGmailDoctor(this.config, deps);
  }

  async authorize(): Promise<void> {
    let raw: string;
    try { raw = await fs.readFile(this.config.gmailCredentialsPath, "utf8"); }
    catch { throw new Error(`Put your Google OAuth desktop credentials at ${this.config.gmailCredentialsPath} first.`); }
    const credentials = JSON.parse(raw) as Record<string, Record<string, string>>;
    const config = credentials.installed || credentials.web || credentials;
    const client = new google.auth.OAuth2(config.client_id, config.client_secret, this.config.gmailRedirectUri);
    const state = randomBytes(32).toString("hex");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const url = client.generateAuthUrl({ access_type: "offline", scope: SCOPES, prompt: "consent", state, code_challenge: challenge, code_challenge_method: CodeChallengeMethod.S256 });
    console.log(`\nOpen this Gmail authorization URL:\n\n${url}\n`);
    if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    const redirect = new URL(this.config.gmailRedirectUri);
    await new Promise<void>((resolve, reject) => {
      const server = http.createServer(async (request, response) => {
        try {
          const incoming = new URL(request.url || "/", `${redirect.protocol}//${redirect.host}`);
          if (incoming.pathname !== redirect.pathname) throw new Error("Unexpected Gmail OAuth callback path");
          const code = incoming.searchParams.get("code");
          const error = incoming.searchParams.get("error");
          if (error) throw new Error(error);
          if (!code) { response.writeHead(400); response.end("Waiting for OAuth callback"); return; }
          if (incoming.searchParams.get("state") !== state) throw new Error("Invalid Gmail OAuth state");
          const token = await client.getToken({ code, codeVerifier: verifier });
          await fs.mkdir(path.dirname(this.config.gmailTokenPath), { recursive: true });
          await fs.chmod(path.dirname(this.config.gmailTokenPath), 0o700).catch(() => undefined);
          await fs.writeFile(this.config.gmailTokenPath, JSON.stringify(token.tokens, null, 2), { encoding: "utf8", mode: 0o600 });
          response.end("Henry is connected to Gmail. You can close this tab.");
          server.close(); resolve();
        } catch (callbackError) { response.writeHead(500); response.end(String(callbackError)); server.close(); reject(callbackError); }
      });
      server.listen(Number(redirect.port || 80), redirect.hostname);
      setTimeout(() => { server.close(); reject(new Error("Gmail authorization timed out after 5 minutes")); }, 300_000).unref();
    });
  }

  async inbox(limit = 10): Promise<InboxMessage[]> {
    const gmail = await this.api();
    const listed = await gmail.users.messages.list({ userId: "me", q: "in:inbox", maxResults: Math.min(Math.max(limit, 1), 50) });
    const messages: InboxMessage[] = [];
    for (const item of listed.data.messages || []) {
      if (!item.id) continue;
      const full = await gmail.users.messages.get({ userId: "me", id: item.id, format: "full" });
      const message = full.data;
      messages.push({
        id: message.id || item.id, threadId: message.threadId || undefined,
        messageId: header(message, "Message-ID") || undefined,
        references: header(message, "References") || undefined,
        from: header(message, "From"), to: header(message, "To"), subject: header(message, "Subject"),
        date: header(message, "Date"), snippet: message.snippet || "", body: textPart(message.payload),
      });
    }
    await this.activity.record("gmail.read", `Read ${messages.length} Gmail messages`, { limit });
    return messages;
  }

  /**
   * Stages an outbound message for Luvish's approval. NOTHING is sent here. When the
   * message is a reply, `inReplyTo`/`references` are the RFC thread identity captured
   * from the message being answered — they ride in the payload so that the eventual
   * approved send can emit real threading headers.
   */
  async queueEmail(input: {
    to: string; subject: string; body: string;
    threadId?: string; inReplyTo?: string; references?: string;
  }): Promise<ApprovalItem> {
    const item = await this.approvals.create({
      kind: "gmail.send", title: `Email ${input.to}: ${input.subject}`, recipient: input.to,
      subject: input.subject, body: input.body,
      payload: {
        to: input.to, subject: input.subject, body: input.body, threadId: input.threadId,
        inReplyTo: input.inReplyTo, references: input.references,
      },
    });
    await this.activity.record("approval.created", `Queued Gmail message for approval`, {
      approvalId: item.id, to: input.to, subject: input.subject, threaded: Boolean(input.inReplyTo || input.threadId),
    });
    return item;
  }

  async sendApproved(item: ApprovalItem): Promise<string> {
    if (item.kind !== "gmail.send") throw new Error(`Not a Gmail approval: ${item.id}`);
    assertOutboundExecutionClaim(item);
    const gmail = await this.api();
    const payload = item.payload as { to: string; subject: string; body: string; threadId?: string; inReplyTo?: string; references?: string };
    const raw = buildRawMessage({
      to: payload.to, subject: payload.subject, body: payload.body,
      threadId: payload.threadId, inReplyTo: payload.inReplyTo, references: payload.references,
    });
    const sent = await gmail.users.messages.send({ userId: "me", requestBody: { raw: toBase64Url(raw), ...(payload.threadId ? { threadId: payload.threadId } : {}) } });
    const id = sent.data.id || "sent";
    await this.activity.record("approval.executed", `Sent Gmail message ${id}`, { approvalId: item.id, messageId: id });
    return id;
  }
}
