import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setActiveProfile } from "../src/profile.ts";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { CommerceService } from "../src/commerce/service.ts";
import { HenryAgent } from "../src/agent/henry.ts";
import type { HenryMemory } from "../src/memory/engram.ts";

test("Kelly injects published catalogue facts directly and never exposes pending rows", async () => {
  setActiveProfile("kelly");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kelly-catalogue-context-"));
  const config = loadConfig(root); config.dataDir = path.join(root, "data");
  await fs.writeFile(path.join(root, "soul.md"), "test soul");
  await fs.writeFile(path.join(root, "personality.md"), "test personality");
  const activity = new ActivityLog(config.activityPath); await activity.init();
  const commerce = new CommerceService(config, activity, { index: async items => items.length, search: async () => [], close() {} });
  const publishedCsv = path.join(root, "published.csv");
  const pendingCsv = path.join(root, "pending.csv");
  await fs.writeFile(publishedCsv, "SKU,Brand,Name,Category,Unit,Price,GST\nPUB-LED,DemoAster,LED bulb 9W,Lighting,piece,100,18\n");
  await fs.writeFile(pendingCsv, "SKU,Brand,Name,Category,Unit,Price,GST\nSECRET-LED,PendingCo,LED bulb 12W,Lighting,piece,90,18\n");
  const published = await commerce.importCatalogue(publishedCsv) as {documentId:string};
  await commerce.publish(published.documentId);
  await commerce.importCatalogue(pendingCsv);
  const memory = { context: async () => "" } as unknown as HenryMemory;
  const agent = new HenryAgent(config, activity, memory, undefined, query => commerce.context(query));
  const prompt = await agent.buildPrompt("What products and categories do you have?", "run-catalogue", true, "codex");
  assert.match(prompt, /Published catalogue \(AUTHORITATIVE CURRENT DATA\)/);
  assert.match(prompt, /Available categories: Lighting/);
  assert.match(prompt, /DemoAster \| PUB-LED \| LED bulb 9W/);
  assert.match(prompt, /₹100\.00/);
  assert.doesNotMatch(prompt, /SECRET-LED|PendingCo/);
  await agent.flushMemoryCaptures(); commerce.close();
});

test("specific requests retrieve structured product rows despite conversational wording", async () => {
  setActiveProfile("kelly");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kelly-catalogue-wording-"));
  const config = loadConfig(root); config.dataDir = path.join(root, "data");
  const activity = new ActivityLog(config.activityPath); await activity.init();
  const commerce = new CommerceService(config, activity, { index: async items => items.length, search: async () => [], close() {} });
  const csv = path.join(root, "catalogue.csv");
  await fs.writeFile(csv, "SKU,Brand,Name,Category,Unit,Price,GST\nFAN-12,DemoBirch,Ceiling fan 1200mm,Appliances,piece,2400,18\n");
  const imported = await commerce.importCatalogue(csv) as {documentId:string}; await commerce.publish(imported.documentId);
  const context = await commerce.context("Mujhe do DemoBirch ceiling fan ka quotation chahiye");
  assert.match(context, /FAN-12/); assert.match(context, /₹2400\.00/); assert.match(context, /source sheet1!2:2/);
  commerce.close();
});

test("multi-item voice requests ignore wrapper text and retrieve every requested product family", async () => {
  setActiveProfile("kelly");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kelly-catalogue-multi-"));
  const config = loadConfig(root); config.dataDir = path.join(root, "data");
  const activity = new ActivityLog(config.activityPath); await activity.init();
  const commerce = new CommerceService(config, activity, { index: async items => items.length, search: async () => [], close() {} });
  const csv = path.join(root, "catalogue.csv");
  await fs.writeFile(csv, [
    "SKU,Brand,Name,Category,Unit,Price,GST",
    "A-FAN,DemoAster,Ceiling fan 1200mm,Appliances,piece,2000,18",
    "A-KETTLE,DemoAster,Kettle 1.5L,Appliances,piece,1000,18",
    "A-CABLE,DemoAster,Cable 2.5 sq mm,Electrical,metre,50,18",
    "A-MCB,DemoAster,MCB 16A,Electrical,piece,250,18",
    "A-CHAIR,DemoAster,Office chair,Furniture,piece,3000,18",
    "A-DESK,DemoAster,Office desk,Furniture,piece,5000,18",
    "B-FAN,DemoBirch,Ceiling fan 1200mm,Appliances,piece,2400,18",
    "B-KETTLE,DemoBirch,Kettle 1.5L,Appliances,piece,1250,18",
    "B-CABLE,DemoBirch,Cable 2.5 sq mm,Electrical,metre,60,18",
    "B-MCB,DemoBirch,MCB 16A,Electrical,piece,300,18",
    "B-CHAIR,DemoBirch,Office chair,Furniture,piece,3500,18",
    "B-DESK,DemoBirch,Office desk,Furniture,piece,5500,18",
  ].join("\n"));
  const imported = await commerce.importCatalogue(csv) as {documentId:string}; await commerce.publish(imported.documentId);
  const request = "I would need one ceiling fan, one kettle, one cable, one meter cable, one MCB, one office chair, one office desk and that's it. How much would it cost me?";
  const context = await commerce.context(request);
  for (const sku of ["A-FAN", "A-KETTLE", "A-CABLE", "A-MCB", "A-CHAIR", "A-DESK", "B-FAN", "B-KETTLE", "B-CABLE", "B-MCB", "B-CHAIR", "B-DESK"]) {
    assert.match(context, new RegExp(`\\b${sku}\\b`));
  }
  assert.match(context, /ask which brand/i);
  assert.match(context, /duplicated or ambiguous/i);

  const memory = { context: async () => "" } as unknown as HenryMemory;
  let catalogueQuery = "";
  const agent = new HenryAgent(config, activity, memory, undefined, async query => { catalogueQuery = query; return commerce.context(query); });
  const wrapped = "VOICE SAFETY WRAPPER WITH MANY UNRELATED WORDS\n\n" + request;
  const prompt = await agent.buildPrompt(wrapped, "run-multi", true, "codex", "owner", request);
  assert.equal(catalogueQuery, request);
  assert.match(prompt, /A-FAN/);
  assert.doesNotMatch(prompt, /No matching published products/);
  await agent.flushMemoryCaptures(); commerce.close();
});

test("Kelly requires English answers for fresh, resumed, and lightweight turns", async () => {
  setActiveProfile("kelly");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kelly-language-policy-"));
  const config = loadConfig(root); config.dataDir = path.join(root, "data");
  await fs.writeFile(path.join(root, "soul.md"), "test soul");
  await fs.writeFile(path.join(root, "personality.md"), "test personality");
  const activity = new ActivityLog(config.activityPath); await activity.init();
  const memory = { context: async () => "" } as unknown as HenryMemory;
  const agent = new HenryAgent(config, activity, memory);

  const fresh = await agent.buildPrompt("Mujhe catalogue dikhao", "fresh", true, "codex");
  const resumed = await agent.buildPrompt("Mujhe catalogue dikhao", "resumed", false, "codex");
  const lightweight = await agent.buildPrompt("namaste", "lightweight", true, "codex");

  for (const prompt of [fresh, resumed, lightweight]) {
    assert.match(prompt, /always answer in clear English/i);
  }
  assert.match(fresh, /preserve Whisper's native script/i);
  await agent.flushMemoryCaptures();
});
