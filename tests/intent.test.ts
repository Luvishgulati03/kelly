import test from "node:test";
import assert from "node:assert/strict";
import { classifyIntentTier, routeIntentTier } from "../src/agent/intent.ts";

const t0 = ["hi", "hey henry", "hello!", "thanks", "thank you", "good night henry", "gm", "ok", "how are you?", "bye 👋"];
const full = [
  "send me a hi at 9",
  "check my email",
  "remind me tomorrow",
  "ok run it",
  "draft a reply to the recruiter",
  "what jobs came in today",
  "open the dashboard",
  "https://example.com/posting",
  "edit my resume to lead with PM work",
  "x".repeat(150),
  "I was thinking about how we should approach the GTM for the new community product and whether the pricing tiers make sense",
];

for (const p of t0) test(`t0: "${p}"`, () => assert.equal(classifyIntentTier(p), "t0"));
for (const p of full) test(`full: "${p.slice(0, 40)}"`, () => assert.equal(classifyIntentTier(p), undefined));

test("the deterministic router keeps routine work with Terra", () => {
  assert.equal(routeIntentTier("draft a short weekly update from these notes"), "t1");
  assert.equal(routeIntentTier("check my email"), "t1");
});

test("the deterministic router reserves high reasoning for difficult work", () => {
  assert.equal(routeIntentTier("review this PR and identify correctness and security issues"), "t2");
  assert.equal(routeIntentTier("debug the production incident and find the root cause"), "t2");
});
