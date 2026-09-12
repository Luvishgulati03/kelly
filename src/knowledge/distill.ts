import type { ProviderRunner } from "../providers/runner.ts";
import { KNOWLEDGE_DOMAINS } from "./store.ts";

export interface StrategyCard {
  title: string;
  claim: string;
  whenToUse: string;
  steps: string[];
  evidence: string;
  domain: string;
  tags: string[];
}

const CHUNK_CHARS = 24_000;

function parseCards(response: string): StrategyCard[] {
  const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || response;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(fenced.slice(start, end + 1)) as { cards?: unknown[] };
    return (parsed.cards || []).flatMap((card) => {
      const c = card as Record<string, unknown>;
      if (typeof c.title !== "string" || typeof c.claim !== "string") return [];
      return [{
        title: c.title, claim: c.claim,
        whenToUse: typeof c.whenToUse === "string" ? c.whenToUse : "",
        steps: Array.isArray(c.steps) ? c.steps.filter((s): s is string => typeof s === "string") : [],
        evidence: typeof c.evidence === "string" ? c.evidence : "",
        domain: KNOWLEDGE_DOMAINS.includes(c.domain as never) ? String(c.domain) : "general",
        tags: Array.isArray(c.tags) ? c.tags.filter((t): t is string => typeof t === "string") : [],
      }];
    });
  } catch { return []; }
}

/** One T1 subscription-CLI call per transcript chunk; long transcripts are chunked and merged. */
export async function distillToCards(
  runner: ProviderRunner,
  input: { name: string; product: string; domainHint: string; text: string },
): Promise<StrategyCard[]> {
  const chunks: string[] = [];
  for (let index = 0; index < input.text.length; index += CHUNK_CHARS) {
    chunks.push(input.text.slice(index, index + CHUNK_CHARS + 500));
  }
  const cards: StrategyCard[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const prompt = [
      "Distill this learning-module transcript into strategy cards: atomic, actionable, tried-and-tested knowledge units.",
      "Each card is one reusable tactic/principle with concrete steps grounded ONLY in the transcript. Never invent facts or numbers.",
      `Card domain must be one of: ${KNOWLEDGE_DOMAINS.join(", ")}. Domain hint for this module: ${input.domainHint}.`,
      'Return ONLY JSON: {"cards":[{"title":string,"claim":string,"whenToUse":string,"steps":string[],"evidence":string,"domain":string,"tags":string[]}]}',
      "Aim for 3-8 cards per chunk; skip filler, anecdotes without a lesson, and logistics.",
      `\n--- module: ${input.name} (product: ${input.product}, part ${index + 1}/${chunks.length}) ---\n${chunk}`,
    ].join("\n");
    const result = await runner.run(prompt, { role: "knowledge-distill", readOnly: true });
    if (result.exitCode === 0) cards.push(...parseCards(result.response));
  }
  return cards;
}
