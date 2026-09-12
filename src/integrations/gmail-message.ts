/**
 * RFC 5322 message construction for outbound Gmail.
 *
 * Gmail's API `threadId` only threads a conversation inside the SENDER's own Gmail;
 * every other mail client threads on `In-Reply-To` / `References`. Henry used to emit
 * neither, so an approved reply landed in the recipient's client as a brand-new
 * conversation. Everything here is pure so the header shape can be tested without a
 * Google client and without the network.
 */

/** Header values are never allowed to carry CR/LF — that is header injection. */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\0]+/g, " ").replace(/\s+$/g, "").replace(/^\s+/g, "");
}

/**
 * Normalises one msg-id to its angle-bracketed form: `abc@x` -> `<abc@x>`, `<<abc@x>>`
 * -> `<abc@x>`. Returns undefined for anything empty or unusable rather than emitting a
 * malformed header.
 */
export function normalizeMessageId(value?: string | null): string | undefined {
  const cleaned = sanitizeHeaderValue(String(value ?? ""));
  if (!cleaned) return undefined;
  const bracketed = cleaned.match(/^\s*<([^<>\s]+)>\s*$/);
  const bare = cleaned.match(/^\s*([^<>\s]+)\s*$/);
  const inner = bracketed?.[1] || bare?.[1];
  if (!inner) return undefined;
  return `<${inner}>`;
}

/** Splits a `References`-style header into its individual angle-bracketed msg-ids. */
export function parseMessageIdList(value?: string | null): string[] {
  const cleaned = sanitizeHeaderValue(String(value ?? ""));
  if (!cleaned) return [];
  const bracketed = cleaned.match(/<[^<>\s]+>/g);
  if (bracketed) return bracketed;
  return cleaned.split(/\s+/).map((token) => normalizeMessageId(token)).filter((id): id is string => Boolean(id));
}

/**
 * RFC 5322 §3.6.4: a reply's `References` is the parent's `References` **plus** the
 * parent's `Message-ID` — it appends, it never replaces. Duplicates are dropped (a
 * long thread otherwise grows the same id repeatedly) while preserving order.
 */
export function buildReferences(existingReferences?: string | null, inReplyTo?: string | null): string | undefined {
  const chain = parseMessageIdList(existingReferences);
  const parent = normalizeMessageId(inReplyTo);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of chain) if (!seen.has(id)) { seen.add(id); ordered.push(id); }
  if (parent && !seen.has(parent)) ordered.push(parent);
  return ordered.length ? ordered.join(" ") : undefined;
}

/**
 * Adds `Re: ` only when the subject is not already a reply subject. Case-insensitive,
 * tolerant of `RE:` / `re :`, so a threaded conversation never becomes `Re: Re: …`.
 */
export function normalizeReplySubject(subject: string): string {
  const trimmed = sanitizeHeaderValue(subject).trim();
  if (!trimmed) return "Re:";
  if (/^re\s*:/i.test(trimmed)) return trimmed;
  return `Re: ${trimmed}`;
}

/**
 * RFC 2047 base64 encoded-words for non-ASCII header text. Chunked on CHARACTER
 * boundaries (never mid-UTF-8-sequence) so every encoded-word stays under the 75-char
 * limit and decodes cleanly; continuation words are folded with CRLF + space.
 */
export function encodeHeaderWords(value: string): string {
  const prefix = "=?UTF-8?B?";
  const suffix = "?=";
  const maxBytes = Math.floor((75 - prefix.length - suffix.length) / 4) * 3;
  const chunks: string[] = [];
  let current = "";
  for (const character of value) {
    const candidate = current + character;
    if (Buffer.byteLength(candidate, "utf8") > maxBytes && current) { chunks.push(current); current = character; }
    else current = candidate;
  }
  if (current) chunks.push(current);
  return chunks.map((chunk) => `${prefix}${Buffer.from(chunk, "utf8").toString("base64")}${suffix}`).join("\r\n ");
}

/** ASCII passes through untouched; anything else (or an over-long line) is encoded. */
export function encodeSubject(subject: string): string {
  const cleaned = sanitizeHeaderValue(subject);
  const needsEncoding = /[^\t\x20-\x7e]/.test(cleaned) || `Subject: ${cleaned}`.length > 900;
  return needsEncoding ? encodeHeaderWords(cleaned) : cleaned;
}

/** Folds a whitespace-separated msg-id list so no line exceeds the RFC line limit. */
export function foldMessageIdHeader(name: string, value: string, limit = 78): string {
  const tokens = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = `${name}:`;
  for (const token of tokens) {
    if (current !== `${name}:` && current.length + 1 + token.length > limit) { lines.push(current); current = ` ${token}`; }
    else current = `${current} ${token}`;
  }
  lines.push(current);
  return lines.join("\r\n");
}

export interface OutgoingMessage {
  to: string;
  subject: string;
  body: string;
  /** The RFC `Message-ID` of the message being replied to (any bracketing accepted). */
  inReplyTo?: string;
  /** The `References` header of the message being replied to. */
  references?: string;
  /** Gmail's own thread id — belt and braces alongside the RFC headers. */
  threadId?: string;
}

/**
 * Builds the full RFC 5322 message. A message is treated as a reply when it carries an
 * `inReplyTo` or a `threadId`; a fresh message gets no `In-Reply-To`, no `References`
 * and no `Re:` prefix — byte-identical in spirit to the old behaviour.
 */
export function buildRawMessage(input: OutgoingMessage): string {
  const inReplyTo = normalizeMessageId(input.inReplyTo);
  const isReply = Boolean(inReplyTo || input.threadId);
  const references = isReply ? buildReferences(input.references, inReplyTo) : undefined;
  const subject = isReply ? normalizeReplySubject(input.subject) : sanitizeHeaderValue(input.subject);

  const headers = [`To: ${sanitizeHeaderValue(input.to)}`, `Subject: ${encodeSubject(subject)}`];
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(foldMessageIdHeader("References", references));
  headers.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit");

  const body = input.body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\r\n");
  return [...headers, "", body].join("\r\n");
}

/** base64url, the encoding the Gmail API's `raw` field expects. */
export function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
