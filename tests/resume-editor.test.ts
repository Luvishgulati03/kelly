import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { ResumeEditorService } from "../src/jobs/resume-editor.ts";
import type { HenryMemory } from "../src/memory/engram.ts";
import type { ProviderRunner } from "../src/providers/runner.ts";
import type { RunResult } from "../src/types.ts";

const EDITED_RESPONSE = "# Luvish's Resume\n\nPM at Acme, 2019-2024. Rewritten for emphasis.\n";

function fakeMemory(): HenryMemory {
  return {
    context: async () => "",
    remember: async () => "mem-id",
  } as unknown as HenryMemory;
}

function fakeRunner(response = EDITED_RESPONSE): ProviderRunner {
  return {
    run: async (): Promise<RunResult> => ({
      runId: "run-1", provider: "codex", response, exitCode: 0, durationMs: 1, events: [],
    }),
  } as unknown as ProviderRunner;
}

async function fakeRenderResume(markdown: string, outputPath: string): Promise<string> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `PDF-STUB\n${markdown}`, "utf8");
  return outputPath;
}

async function setup(): Promise<{ config: ReturnType<typeof loadConfig>; activity: ActivityLog }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-resume-editor-"));
  const config = loadConfig(rootDir);
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  return { config, activity };
}

test("edit() throws with import guidance when resume.md is missing", async () => {
  const { config, activity } = await setup();
  const service = new ResumeEditorService(config, activity, fakeMemory(), fakeRunner(), fakeRenderResume);
  await assert.rejects(
    () => service.edit("Tighten the summary and cut the internship."),
    /henry cover import/,
  );
});

test("edit() writes markdown + PDF drafts without touching resume.md", async () => {
  const { config, activity } = await setup();
  const originalResume = "# Luvish's Resume\n\nPM at Acme, 2019-2024.\n";
  await fs.writeFile(config.resumeSourcePath, originalResume, "utf8");
  const service = new ResumeEditorService(config, activity, fakeMemory(), fakeRunner(), fakeRenderResume);

  const result = await service.edit("Emphasize growth metrics.");

  await fs.access(result.markdownPath);
  await fs.access(result.pdfPath);
  const markdown = await fs.readFile(result.markdownPath, "utf8");
  assert.match(markdown, /Rewritten for emphasis/);
  const pdf = await fs.readFile(result.pdfPath, "utf8");
  assert.match(pdf, /PDF-STUB/);

  // resume.md is untouched — edit() must never overwrite it automatically.
  const untouched = await fs.readFile(config.resumeSourcePath, "utf8");
  assert.equal(untouched, originalResume);
});

// A draft that satisfies parseResume (the gate promote() enforces): name + at least one experience entry.
const PARSEABLE_DRAFT = `# LUVISH GULATI

+00-1 | Bengaluru | luvish@example.com | LinkedIn

## PROFILE

Ships product.

## EXPERIENCE

### Acme | Bengaluru — PM (2025 - Present)

- Shipped the thing.

## EDUCATION

B.Tech — Example University (2021 - 2025)

## SKILLS

- **Product:** PRDs
`;

test("promote() copies a PARSEABLE edited draft over the canonical resume source", async () => {
  const { config, activity } = await setup();
  await fs.writeFile(config.resumeSourcePath, "# Luvish's Resume\n\nOld version.\n", "utf8");
  const service = new ResumeEditorService(config, activity, fakeMemory(), fakeRunner(), fakeRenderResume);

  const draftPath = path.join(config.dataDir, "resumes", "edited-draft.md");
  await fs.mkdir(path.dirname(draftPath), { recursive: true });
  await fs.writeFile(draftPath, PARSEABLE_DRAFT, "utf8");

  const promoted = await service.promote(draftPath);

  assert.equal(promoted, config.resumeSourcePath);
  const finalResume = await fs.readFile(config.resumeSourcePath, "utf8");
  assert.equal(finalResume, PARSEABLE_DRAFT);
});

test("promote() refuses an unparseable draft: resume.md untouched, draft copied to .rejected", async () => {
  const { config, activity } = await setup();
  const original = "# Luvish's Resume\n\nOld version.\n";
  await fs.writeFile(config.resumeSourcePath, original, "utf8");
  const service = new ResumeEditorService(config, activity, fakeMemory(), fakeRunner(), fakeRenderResume);

  const draftPath = path.join(config.dataDir, "resumes", "broken-draft.md");
  await fs.mkdir(path.dirname(draftPath), { recursive: true });
  // No ## EXPERIENCE entries → parseResume throws → promoting this would brick every later `jd`.
  await fs.writeFile(draftPath, EDITED_RESPONSE, "utf8");

  await assert.rejects(() => service.promote(draftPath), /does not parse as a resume/);
  assert.equal(await fs.readFile(config.resumeSourcePath, "utf8"), original, "the canonical resume must be untouched");
  const rejected = await fs.readFile(`${config.resumeSourcePath}.rejected`, "utf8");
  assert.equal(rejected, EDITED_RESPONSE, "the refused draft lands in the sibling .rejected file");
});
