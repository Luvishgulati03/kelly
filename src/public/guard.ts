/**
 * OUTPUT-SIDE GUARD for public replies. The public sandbox already means the model cannot read a
 * file; this is the second rail: any reply that LOOKS like it carries a secret, a credential, a
 * local filesystem path, a private Kelly file, or Kelly's own prompt scaffolding is replaced by a
 * neutral line before a visitor sees (or hears) it. False positives cost one polite refusal; false
 * negatives cost a leak, so the patterns lean strict. Replies are guarded one sentence at a time
 * as they stream, and once more as a whole.
 */

export interface GuardResult {
  ok: boolean;
  /** The text to show: the reply when ok, otherwise the neutral refusal. */
  text: string;
  /** Which rule fired (for the owner's content-free log only; never shown to a visitor). */
  reason?: string;
}

const RULES: Array<{ name: string; pattern: RegExp }> = [
  // Local filesystem paths (macOS, Linux, Windows, home shorthand).
  { name: "local path", pattern: /(?:^|[\s"'`(\[<:=])(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/|\/etc\/|\/opt\/|\/Volumes\/|\/tmp\/|\/root\/|~\/|[A-Za-z]:\\)/ },
  // Private files and stores Kelly must never talk about opening.
  { name: "private file", pattern: /(?:^|[\s"'`(\/])\.env\b|\b(?:soul|personality|context|AGENTS|CLAUDE)\.md\b|\b(?:engram|commerce|designs|auth|users|knowledge|catalogue-rag|conversation-rag)\.db\b|\bsettings\.json\b|\bweb-chat\.json\b|\bapprovals?\.json\b|\bactivity\.jsonl\b|\bid_(?:rsa|ed25519)\b|\.ssh\/|\bcert\.pem\b|\.codex\/config\.toml/i },
  // Credentials.
  { name: "api key", pattern: /\b(?:sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,})/ },
  { name: "github token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { name: "slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{12,}/ },
  { name: "aws key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "google key", pattern: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { name: "telegram token", pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i },
  { name: "env assignment", pattern: /\b(?:KELLY|HENRY|LAVU|TELEGRAM|OPENAI|ANTHROPIC|CODEX|CLAUDE|GITHUB|GH|AWS|CLOUDFLARE|TUNNEL)_[A-Z0-9_]*\s*[=:]/ },
  { name: "secret assignment", pattern: /\b(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*\S{6,}/i },
  // A long unbroken run of letters AND digits reads as a key or token, not prose.
  { name: "opaque token", pattern: /(?<![A-Za-z0-9/_.-])(?=[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-]))(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}/ },
  // Kelly's own prompt scaffolding (a sign the model is reciting its instructions).
  { name: "prompt scaffolding", pattern: /<\/?(?:shop_catalogue|server_quote|visitor_message|conversation_so_far)>|HARD RULES \(these override|PUBLIC EXPLORE PERSONA/ },
];

export function publicRefusalLine(): string {
  return "I can't share that. I'm happy to help with the shop's items, prices and designs, though.";
}

/**
 * Checks a reply (or one streamed sentence of it). `blockedValues` are exact strings that must never
 * appear (the owner's configured tokens and chat ids, handed in by the caller); values shorter than
 * 8 characters are ignored so a blank or trivial config value cannot block every reply.
 */
export function guardPublicReply(reply: string, blockedValues: Array<string | undefined> = []): GuardResult {
  const text = reply.trim();
  if (!text) return { ok: false, text: "Sorry, I lost my train of thought. Could you ask that again?", reason: "empty reply" };
  for (const value of blockedValues) {
    if (value && value.length >= 8 && text.includes(value)) return { ok: false, text: publicRefusalLine(), reason: "configured secret" };
  }
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return { ok: false, text: publicRefusalLine(), reason: rule.name };
  }
  return { ok: true, text };
}
