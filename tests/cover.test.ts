import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { CoverLetterService } from "../src/jobs/cover.ts";
import type { HenryMemory } from "../src/memory/engram.ts";
import type { ProviderRunner } from "../src/providers/runner.ts";
import type { RunResult } from "../src/types.ts";
import type { JobApplicationService } from "../src/jobs/service.ts";
import type { JobPosting } from "../src/jobs/types.ts";

const LETTER_RESPONSE = "# PM Role\nDear team, this is a fabricated test cover letter body.";

function fakeMemory(): HenryMemory {
  return {
    context: async () => "",
    remember: async () => "mem-id",
  } as unknown as HenryMemory;
}

function fakeRunner(response = LETTER_RESPONSE): ProviderRunner {
  return {
    run: async (): Promise<RunResult> => ({
      runId: "run-1", provider: "codex", response, exitCode: 0, durationMs: 1, events: [],
    }),
  } as unknown as ProviderRunner;
}

function fakeJobs(inspectCalls: string[]): JobApplicationService {
  return {
    inspect: async (url: string): Promise<JobPosting> => {
      inspectCalls.push(url);
      return {
        id: "posting-1", url, source: "generic", title: "PM", company: "Acme",
        description: "Job description text.", descriptionHash: "hash-1", questions: [],
        discoveredAt: new Date().toISOString(),
      };
    },
  } as unknown as JobApplicationService;
}

async function fakeRenderResume(markdown: string, outputPath: string): Promise<string> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `PDF-STUB\n${markdown}`, "utf8");
  return outputPath;
}

async function setup(): Promise<{ config: ReturnType<typeof loadConfig>; activity: ActivityLog }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-cover-"));
  const config = loadConfig(rootDir);
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  return { config, activity };
}

test("generate() throws with import guidance when resume.md is missing", async () => {
  const { config, activity } = await setup();
  const service = new CoverLetterService(config, activity, fakeMemory(), fakeRunner(), fakeJobs([]), fakeRenderResume);
  await assert.rejects(
    () => service.generate("We need a product manager to lead growth initiatives."),
    /henry cover import/,
  );
});

test("generate() writes markdown + PDF containing the model's response when resume.md exists", async () => {
  const { config, activity } = await setup();
  await fs.writeFile(config.resumeSourcePath, "# Luvish's Resume\n\nPM at Acme, 2019-2024.\n", "utf8");
  const service = new CoverLetterService(config, activity, fakeMemory(), fakeRunner(), fakeJobs([]), fakeRenderResume);

  const result = await service.generate("We need a product manager to lead growth initiatives.");

  assert.equal(result.title, "PM Role");
  assert.equal(result.company, "the company");
  await fs.access(result.markdownPath);
  await fs.access(result.pdfPath);
  const markdown = await fs.readFile(result.markdownPath, "utf8");
  assert.match(markdown, /fabricated test cover letter body/);
  const pdf = await fs.readFile(result.pdfPath, "utf8");
  assert.match(pdf, /PDF-STUB/);
});

test("importResume() accepts a parseable resume and refuses unparseable text into a .rejected sibling", async () => {
  const { config, activity } = await setup();
  const service = new CoverLetterService(config, activity, fakeMemory(), fakeRunner(), fakeJobs([]), fakeRenderResume);

  const parseable = [
    "# LUVISH GULATI", "",
    "+00-1 | Bengaluru | luvish@example.com | LinkedIn", "",
    "## PROFILE", "", "Ships product.", "",
    "## EXPERIENCE", "", "### Acme | Bengaluru — PM (2025 - Present)", "", "- Shipped the thing.", "",
    "## EDUCATION", "", "B.Tech — Example University (2021 - 2025)", "",
    "## SKILLS", "", "- **Product:** PRDs", "",
  ].join("\n");
  const goodSource = path.join(config.dataDir, "incoming-resume.md");
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(goodSource, parseable, "utf8");
  assert.equal(await service.importResume(goodSource), config.resumeSourcePath);
  const imported = await fs.readFile(config.resumeSourcePath, "utf8");
  assert.match(imported, /## EXPERIENCE/);

  // Unparseable text must never overwrite the good canonical resume (audit M9 — it bricks every later `jd`).
  const badSource = path.join(config.dataDir, "raw-docx-dump.txt");
  await fs.writeFile(badSource, "Luvish Gulati\nProduct Manager\nlots of unstructured docx text\n", "utf8");
  await assert.rejects(() => service.importResume(badSource), /does not match the resume\.md structure/);
  assert.equal(await fs.readFile(config.resumeSourcePath, "utf8"), imported, "the previously imported resume must be untouched");
  const rejected = await fs.readFile(`${config.resumeSourcePath}.rejected`, "utf8");
  assert.match(rejected, /unstructured docx text/, "the refused text lands in the sibling .rejected file");
});

test("generate() calls jobs.inspect when given a URL", async () => {
  const { config, activity } = await setup();
  await fs.writeFile(config.resumeSourcePath, "# Luvish's Resume\n\nPM at Acme, 2019-2024.\n", "utf8");
  const inspectCalls: string[] = [];
  const service = new CoverLetterService(config, activity, fakeMemory(), fakeRunner(), fakeJobs(inspectCalls), fakeRenderResume);

  const url = "https://boards.example.com/jobs/42";
  const result = await service.generate(url);

  assert.deepEqual(inspectCalls, [url]);
  assert.equal(result.company, "Acme");
  await fs.access(result.markdownPath);
  await fs.access(result.pdfPath);
});
