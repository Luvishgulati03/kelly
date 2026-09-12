import fs from "node:fs/promises";
import path from "node:path";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { HenryMemory } from "../memory/engram.ts";
import type { ProviderRunner } from "../providers/runner.ts";

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "linkedin-draft";
}

export interface LinkedInDraft {
  markdownPath: string;
  topic: string;
  draft: string;
}

/**
 * LinkedIn post drafting: one t1 read-only call in Luvish's voice, grounded in personality.md
 * and resume.md. DRAFT ONLY — there is no posting integration; Luvish reviews and posts by hand.
 */
export class LinkedInDraftService {
  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    private readonly memory: HenryMemory,
    private readonly runner: ProviderRunner,
  ) {}

  async draft(topic: string): Promise<LinkedInDraft> {
    const trimmed = topic.trim();
    if (!trimmed) throw new Error("Usage: henry linkedin <topic...>");

    const persona = await fs.readFile(path.join(this.config.rootDir, "personality.md"), "utf8").catch(() => "");
    const resume = await fs.readFile(this.config.resumeSourcePath, "utf8").catch(() => "");
    const memoryContext = await this.memory.context(
      `LinkedIn post about: ${trimmed}. Luvish's voice, career narrative, recent work, positioning for Product Manager roles.`,
      8,
    ).catch(() => "");

    const prompt = [
      "Draft a LinkedIn post in Luvish's voice on the topic below. Luvish is a product-minded software engineer targeting Product Manager roles — write a substantive builder-narrative post grounded in real work, not a listicle or hype announcement.",
      "Rules: 120-220 words. Hook first line (never 'Excited to announce...' or similar openers). No hashtag spam — zero to two hashtags, only if they add real discoverability. No emojis unless one lands naturally and sparingly. No generic filler, no forced humility, no flattery padding.",
      "Ground every concrete claim (roles, metrics, outcomes) in the resume and recalled-memory context below — never invent achievements, employers, or numbers not present there. If the topic needs a detail you don't have, write around it rather than inventing it.",
      "Return ONLY the finished post text as markdown (plain paragraphs, no heading, no commentary about the post).",
      `\n--- topic ---\n${trimmed}`,
      `\n--- personality / voice notes ---\n${persona || "n/a"}`,
      `\n--- resume highlights ---\n${resume || "n/a"}`,
      `\n--- recalled memories (Luvish's thinking) ---\n${memoryContext || "n/a"}`,
    ].join("\n");

    const result = await this.runner.run(prompt, { role: "linkedin-draft", readOnly: true, tier: "t1" });
    if (result.exitCode !== 0 || !result.response.trim()) throw new Error(result.error || "LinkedIn draft generation failed");
    const draft = result.response.trim();

    await fs.mkdir(this.config.socialDir, { recursive: true, mode: 0o700 });
    const base = `linkedin-${new Date().toISOString().slice(0, 10)}-${slugify(trimmed)}`;
    const markdownPath = path.join(this.config.socialDir, `${base}.md`);
    await fs.writeFile(markdownPath, `${draft}\n`, "utf8");

    await this.activity.record("social.drafted", `LinkedIn draft: ${trimmed.slice(0, 120)}`, { markdownPath, topic: trimmed });
    await this.memory.remember(
      `Drafted a LinkedIn post about: ${trimmed}. File: ${markdownPath}`,
      { tier: "episodic", importance: 4, metadata: { domain: "social", kind: "linkedin-draft" } },
    ).catch(() => "");

    return { markdownPath, topic: trimmed, draft };
  }
}
