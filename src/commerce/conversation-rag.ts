import { createHash } from "node:crypto";
import path from "node:path";
import type { HenryConfig } from "../config.ts";
import { KnowledgeBase } from "../knowledge/store.ts";

export type ConversationScope = "owner" | `customer:${string}`;

export function conversationScopeForSurface(surface: string | undefined): ConversationScope {
  if (!surface?.startsWith("customer:")) return "owner";
  const id = surface.slice("customer:".length).trim();
  return id ? `customer:${id}` : "owner";
}

function scopeKey(scope: ConversationScope): string {
  if (scope === "owner") return "owner";
  return `customer-${createHash("sha256").update(scope).digest("hex").slice(0, 20)}`;
}

/** A secondary Q&A index. Catalogue and transaction stores remain authoritative. */
export class ConversationRag {
  private readonly stores = new Map<string, KnowledgeBase>();

  constructor(private readonly config: HenryConfig) {}

  private store(scope: ConversationScope): KnowledgeBase {
    const key = scopeKey(scope);
    let store = this.stores.get(key);
    if (!store) {
      store = new KnowledgeBase({ ...this.config, knowledgeDbPath: path.join(this.config.dataDir, "conversation-rag", `${key}.db`) });
      this.stores.set(key, store);
    }
    return store;
  }

  async remember(question: string, answer: string, scope: ConversationScope): Promise<string | undefined> {
    const cleanQuestion = question.trim();
    const cleanAnswer = answer.trim();
    if (!cleanQuestion || !cleanAnswer) return undefined;
    return this.store(scope).add({
      source: `conversation-qa:${scopeKey(scope)}:${createHash("sha256").update(cleanQuestion + "\n" + cleanAnswer).digest("hex").slice(0, 24)}`,
      content: `Question: ${cleanQuestion}\nAnswer: ${cleanAnswer}`,
      importance: 5,
      metadata: { layer: "conversation-qa", scope: scopeKey(scope), createdAt: new Date().toISOString() },
    });
  }

  async context(question: string, scope: ConversationScope, k = 4): Promise<string> {
    const results = await this.store(scope).recall(question, { k, minScore: 0.02, markUsed: true, reinforce: true });
    if (!results.length) return "";
    return [
      "--- Similar past Kelly questions (SECONDARY context, may be stale) ---",
      "Use these only to answer repeated wording faster. Approved catalogue records, current price versions, quote data and source evidence always override them. Never copy a prior price or compatibility claim without rechecking its authoritative store.",
      ...results.map((result, index) => `[${index + 1}] ${result.content.slice(0, 1400)}`),
    ].join("\n");
  }

  close(): void {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
  }
}
