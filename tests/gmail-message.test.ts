import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRawMessage,
  buildReferences,
  normalizeMessageId,
  normalizeReplySubject,
  parseMessageIdList,
  toBase64Url,
} from "../src/integrations/gmail-message.ts";

test("message ids and References are normalised without replacing the parent chain", () => {
  assert.equal(normalizeMessageId("abc@example.com"), "<abc@example.com>");
  assert.equal(normalizeMessageId(" <abc@example.com> "), "<abc@example.com>");
  assert.equal(normalizeMessageId("<abc@example.com> <extra@example.com>"), undefined);
  assert.deepEqual(parseMessageIdList("<one@example.com> <two@example.com>"), [
    "<one@example.com>", "<two@example.com>",
  ]);
  assert.equal(
    buildReferences("<one@example.com> <two@example.com> <one@example.com>", "two@example.com"),
    "<one@example.com> <two@example.com>",
  );
});

test("reply MIME carries Gmail and RFC threading identity", () => {
  const raw = buildRawMessage({
    to: "Jane Doe <jane@example.com>",
    subject: "Contract review",
    body: "Thanks, Jane.\nLooks good.",
    threadId: "gmail-thread-1",
    inReplyTo: "parent@example.com",
    references: "<root@example.com>",
  });

  assert.match(raw, /^To: Jane Doe <jane@example\.com>\r\n/m);
  assert.match(raw, /^Subject: Re: Contract review\r\n/m);
  assert.match(raw, /^In-Reply-To: <parent@example\.com>\r\n/m);
  assert.match(raw, /^References: <root@example\.com> <parent@example\.com>\r\n/m);
  assert.match(raw, /\r\n\r\nThanks, Jane\.\r\nLooks good\.$/);
  assert.equal(normalizeReplySubject("RE: Contract review"), "RE: Contract review");
});

test("header injection is neutralised and a fresh message has no reply headers", () => {
  const raw = buildRawMessage({
    to: "person@example.com\r\nBcc: attacker@example.com",
    subject: "New work\r\nBcc: attacker@example.com",
    body: "hello",
  });
  assert.doesNotMatch(raw, /\r\nBcc:/);
  assert.doesNotMatch(raw, /^In-Reply-To:/m);
  assert.doesNotMatch(raw, /^References:/m);
  assert.match(raw, /^Subject: New work Bcc: attacker@example\.com\r\n/m);
});

test("base64url encoding is suitable for Gmail raw messages", () => {
  assert.equal(toBase64Url("hello ✓"), "aGVsbG8g4pyT");
  assert.doesNotMatch(toBase64Url("padding?"), /[+/=]/);
});
