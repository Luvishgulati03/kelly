import test from "node:test";
import assert from "node:assert/strict";
import { detectKnowledgeDomain } from "../src/knowledge/router.ts";

test("detectKnowledgeDomain routes a GTM phrase to 'gtm'", () => {
  assert.equal(detectKnowledgeDomain("how do I plan a go-to-market launch for this community product"), "gtm");
});

test("detectKnowledgeDomain routes a PM phrase to 'product-management'", () => {
  assert.equal(detectKnowledgeDomain("help me write a PRD for the new roadmap"), "product-management");
});

test("detectKnowledgeDomain routes a software bug report to 'software-development'", () => {
  assert.equal(detectKnowledgeDomain("fix this typescript bug"), "software-development");
});

test("detectKnowledgeDomain routes a sales phrase to 'sales'", () => {
  assert.equal(detectKnowledgeDomain("how do I close this deal in my outbound pipeline"), "sales");
});

test("detectKnowledgeDomain routes a careers phrase to 'careers'", () => {
  assert.equal(detectKnowledgeDomain("tips for my upcoming job interview"), "careers");
});

test("detectKnowledgeDomain returns null for ordinary chit-chat", () => {
  assert.equal(detectKnowledgeDomain("hello henry"), null);
  assert.equal(detectKnowledgeDomain("what's the weather like today"), null);
});
