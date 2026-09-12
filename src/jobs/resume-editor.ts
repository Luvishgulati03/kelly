import fs from "node:fs/promises";
import path from "node:path";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { HenryMemory } from "../memory/engram.ts";
import type { ProviderRunner } from "../providers/runner.ts";
import { renderResumePdf, type ResumeRenderer } from "./resume.ts";
import { parseResume } from "./tailor.ts";

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "resume-edit";
}

export class ResumeEditorService {
  private readonly renderResume: ResumeRenderer;

  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    private readonly memory: HenryMemory,
    private readonly runner: ProviderRunner,
    renderResume?: ResumeRenderer,
  ) {
    this.renderResume = renderResume || renderResumePdf;
  }

  /** The resume is REQUIRED and re-read on every call — resume edits are never made without it. */
  private async resume(): Promise<string> {
    const text = await fs.readFile(this.config.resumeSourcePath, "utf8").catch(() => "");
    if (!text.trim()) {
      throw new Error(`Resume not found at ${this.config.resumeSourcePath}. Run: henry cover import <path-to-resume.docx>`);
    }
    return text;
  }

  /** Rewrites the resume per instructions. Never overwrites resume.md — returns a new draft for Luvish to review. */
  async edit(instructions: string): Promise<{ markdownPath: string; pdfPath: string }> {
    const resume = await this.resume();
    const prompt = [
      "Rewrite Luvish's resume markdown per the instructions below. STRICT rules: never invent employers, roles, dates, degrees, metrics, or skills not present in the current resume or the instructions; reordering, rewording, emphasis changes, and cutting are allowed; additions come ONLY from the instructions. Keep it one page dense. Luvish's target: Product Manager roles. Return ONLY the full updated resume as markdown.",
      `\n--- current resume ---\n${resume}`,
      `\n--- instructions ---\n${instructions}`,
    ].join("\n");
    const result = await this.runner.run(prompt, { role: "resume-editor", readOnly: true });
    if (result.exitCode !== 0 || !result.response.trim()) throw new Error(result.error || "Resume edit failed");
    const updated = result.response.trim();

    const outDir = path.join(this.config.dataDir, "resumes");
    await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
    const base = `edited-${new Date().toISOString().slice(0, 10)}-${slugify(instructions)}`;
    const markdownPath = path.join(outDir, `${base}.md`);
    await fs.writeFile(markdownPath, `${updated}\n`, "utf8");
    const pdfPath = await this.renderResume(updated, path.join(outDir, `${base}.pdf`));
    await this.activity.record("resume.generated", `Edited resume draft: ${instructions.slice(0, 120)}`, { markdownPath, pdfPath });
    await this.memory.remember(
      `Edited resume draft per instructions: ${instructions.slice(0, 240)}. File: ${markdownPath}`,
      { tier: "episodic", importance: 4, metadata: { domain: "jobs", kind: "resume-edit" } },
    ).catch(() => "");
    return { markdownPath, pdfPath };
  }

  /** Luvish's acceptance step: copies an edited draft over the canonical resume source. */
  async promote(markdownPath: string): Promise<string> {
    const text = await fs.readFile(markdownPath, "utf8").catch(() => "");
    if (!text.trim()) throw new Error(`Edited resume not found at ${markdownPath}`);
    // Same gate as cover.importResume (audit M9): promoting a draft that
    // parseResume can't read would brick every later `jd` run.
    try { parseResume(text); } catch (error) {
      const rejectedPath = `${this.config.resumeSourcePath}.rejected`;
      await fs.writeFile(rejectedPath, text, "utf8");
      throw new Error(
        `Draft ${markdownPath} does not parse as a resume (${error instanceof Error ? error.message : String(error)}). ` +
        `Copy saved to ${rejectedPath}; ${this.config.resumeSourcePath} was NOT touched.`,
      );
    }
    await fs.writeFile(this.config.resumeSourcePath, text, "utf8");
    await this.activity.record("resume.generated", `Promoted resume draft to ${this.config.resumeSourcePath}`, { markdownPath, resumeSourcePath: this.config.resumeSourcePath });
    await this.memory.remember(
      `Promoted resume draft ${markdownPath} to canonical resume.`,
      { tier: "episodic", importance: 4, metadata: { domain: "jobs", kind: "resume-promote" } },
    ).catch(() => "");
    return this.config.resumeSourcePath;
  }
}
