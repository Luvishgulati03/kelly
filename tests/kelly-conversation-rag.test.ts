import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ConversationRag, conversationScopeForSurface } from "../src/commerce/conversation-rag.ts";

test("Kelly conversation scope defaults to owner and isolates named customers", () => {
  assert.equal(conversationScopeForSurface(undefined), "owner");
  assert.equal(conversationScopeForSurface("web-chat:abc"), "owner");
  assert.equal(conversationScopeForSurface("customer:cust-42"), "customer:cust-42");
});

test("Kelly embeds Q&A and never cross-retrieves between customer databases", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kelly-conversation-rag-"));
  const config = loadConfig(root);
  config.dataDir = path.join(root, "data");
  const rag = new ConversationRag(config);

  await rag.remember("Which fan fits the blue bedroom?", "Use SKU FAN-A for the blue bedroom.", "customer:alice");
  await rag.remember("Which fan fits the green bedroom?", "Use SKU FAN-B for the green bedroom.", "customer:bob");

  const alice = await rag.context("fan for the blue bedroom", "customer:alice");
  const bob = await rag.context("fan for the green bedroom", "customer:bob");
  assert.match(alice, /FAN-A/);
  assert.doesNotMatch(alice, /FAN-B/);
  assert.match(bob, /FAN-B/);
  assert.doesNotMatch(bob, /FAN-A/);

  const files = await fs.readdir(path.join(config.dataDir, "conversation-rag"));
  assert.equal(files.filter((file) => file.endsWith(".db")).length, 2);
  assert.ok(files.every((file) => !file.includes("alice") && !file.includes("bob")), "customer ids are hashed on disk");
  rag.close();
});
