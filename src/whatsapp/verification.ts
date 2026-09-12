import crypto from "node:crypto";

/** Return Meta's challenge only for a valid subscribe verification request. */
export function verifyMetaChallenge(
  mode: unknown,
  verifyToken: unknown,
  challenge: unknown,
  expectedVerifyToken: string,
): string | null {
  if (
    mode !== "subscribe" || typeof verifyToken !== "string" || verifyToken.length === 0 ||
    typeof challenge !== "string" || challenge.length === 0 || expectedVerifyToken.length === 0
  ) return null;
  return constantTimeTextEqual(verifyToken, expectedVerifyToken) ? challenge : null;
}

/** Verify Meta's `X-Hub-Signature-256` over the exact, unparsed request bytes. */
export function verifyWebhookSignature(
  rawBody: string | Buffer | Uint8Array,
  signatureHeader: string | undefined | null,
  appSecret: string,
): boolean {
  if (!signatureHeader || !appSecret || !/^sha256=[0-9a-fA-F]{64}$/.test(signatureHeader)) return false;
  const supplied = Buffer.from(signatureHeader.slice(7), "hex");
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest();
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function constantTimeTextEqual(candidate: string, expected: string): boolean {
  const candidateDigest = crypto.createHash("sha256").update(candidate).digest();
  const expectedDigest = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(candidateDigest, expectedDigest);
}
