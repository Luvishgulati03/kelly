import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JobApplicationService } from "../src/jobs/service.ts";
import type { HenryConfig } from "../src/config.ts";
import type { ActivityLog } from "../src/activity.ts";
import type { ApprovalStore } from "../src/approval/store.ts";
import type { HenryMemory } from "../src/memory/engram.ts";
import type { ProviderRunner } from "../src/providers/runner.ts";
import type { JobBrowser } from "../src/jobs/browser.ts";
import { chromium } from "playwright";

// Synthetic fixture: no candidate data, browser, provider, or live approval execution.
async function pdf(text: string): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<p>${text}</p>`);
    return await page.pdf();
  } finally { await browser.close(); }
}

async function setup(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-job-source-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = { jobProfilePath: path.join(dir, "profile.md"), resumeSourcePath: path.join(dir, "resume.md"), resumeOutputDir: path.join(dir, "out"), jobApplicationsPath: path.join(dir, "applications.json") } as HenryConfig;
  await fs.writeFile(config.jobProfilePath, "Candidate profile: TypeScript");
  await fs.writeFile(config.resumeSourcePath, "DEFAULT_RESUME_FACT");
  const calls = { prompt: "", renders: 0, inspections: 0, approvals: 0, attachment: "", body: "" };
  const browser: JobBrowser = {
    async inspect(url) { calls.inspections++; return { url, title: "Engineer", company: "Example", description: "JOB_REQUIREMENT_NOT_CANDIDATE_FACT", questions: [], capturedAt: new Date().toISOString() }; },
    async fill(url, draft) { calls.attachment = draft.resumePdfPath || ""; return { url, filled: [], skipped: [] }; },
    async submit() { throw new Error("Must never submit"); },
  };
  const service = new JobApplicationService(config,
    { record: async () => {} } as unknown as ActivityLog,
    { create: async (input: { body: string }) => { calls.approvals++; calls.body = input.body; return { id: "pending" }; } } as unknown as ApprovalStore,
    { remember: async () => "memory", context: async () => { throw new Error("Must not recall job content as candidate evidence"); } } as unknown as HenryMemory,
    { run: async (prompt: string, options: { role: string }) => {
      if (options.role === "application-review") return { exitCode: 0, response: JSON.stringify({ accepted: true, issues: [] }) };
      calls.prompt = prompt; return { exitCode: 0, response: JSON.stringify({ coverLetter: "Truthful letter", answers: {}, missingFacts: [], resumeMarkdown: "Generated resume" }) };
    } } as unknown as ProviderRunner,
    browser, async (_markdown, output) => { calls.renders++; await fs.writeFile(output, "synthetic-pdf"); return output; });
  await service.init();
  return { dir, config, calls, service };
}

test("explicit PDF is extracted and kept unchanged as the fill attachment despite generated markdown", async t => {
  const { dir, calls, service } = await setup(t);
  const source = path.join(dir, "supplied.PDF");
  const bytes = await pdf("SOURCE_PDF_FACT");
  await fs.writeFile(source, bytes);
  const draft = await service.prepare("https://example.com/job", undefined, source);
  assert.match(calls.prompt, /SOURCE_PDF_FACT/);
  assert.doesNotMatch(calls.prompt, /DEFAULT_RESUME_FACT|recalled Engram context/);
  assert.match(calls.prompt, /Never invent or infer country, work authorization, total years of experience/);
  assert.match(calls.prompt, /Return empty resumeMarkdown and empty resumeEdits/);
  assert.match(calls.prompt, /sensitive survey answers/);
  assert.match(calls.prompt, /referral sources/);
  assert.match(calls.prompt, /source resume takes precedence over the candidate profile/);
  assert.match(calls.prompt, /Do not claim Claude is currently the primary coding agent/);
  assert.equal(draft.resumePdfPath, source);
  assert.equal(draft.resumeMarkdownPath, undefined);
  assert.equal(calls.renders, 0);
  assert.equal(draft.coverLetter, "Truthful letter");
  await service.fill(draft.id);
  assert.equal(calls.attachment, source);
  assert.deepEqual(await fs.readFile(source), bytes);
  assert.match(calls.body, /Original supplied PDF/);
  await fs.appendFile(source, "changed");
  await assert.rejects(service.fill(draft.id), /Resume bytes changed/);
});

test("text override and default source still render tailored resumes", async t => {
  const { dir, calls, service } = await setup(t);
  const source = path.join(dir, "supplied.txt");
  await fs.writeFile(source, "TEXT_SOURCE_FACT");
  const draft = await service.prepare("https://example.com/job", undefined, source);
  assert.match(calls.prompt, /TEXT_SOURCE_FACT/);
  assert.doesNotMatch(calls.prompt, /DEFAULT_RESUME_FACT/);
  assert.ok(draft.resumeMarkdownPath);
  assert.equal(calls.renders, 1);
  await service.prepare("https://example.com/job");
  assert.match(calls.prompt, /DEFAULT_RESUME_FACT/);
  assert.equal(calls.renders, 2);
});

test("explicit missing, empty, unreadable PDF and textless PDF fail before inspection or generation", async t => {
  const { dir, calls, service } = await setup(t);
  const empty = path.join(dir, "empty.txt");
  const invalid = path.join(dir, "invalid.pdf");
  const blank = path.join(dir, "blank.pdf");
  await fs.writeFile(empty, " \n\t");
  await fs.writeFile(invalid, "not a pdf");
  await fs.writeFile(blank, await pdf(""));
  for (const source of ["", "  ", path.join(dir, "missing.pdf"), empty, invalid, blank]) {
    await assert.rejects(service.prepare("https://example.com/job", undefined, source), /[Ee]xplicit resume/);
  }
  assert.equal(calls.inspections, 0);
  assert.equal(calls.prompt, "");
  assert.equal(calls.approvals, 0);
  assert.deepEqual(await service.store.list(), []);
});

test("missing default resume stays optional and cannot produce an invented attachment", async t => {
  const { config, calls, service } = await setup(t);
  await fs.unlink(config.resumeSourcePath);
  const draft = await service.prepare("https://example.com/job");
  assert.equal(draft.resumePdfPath, undefined);
  assert.equal(calls.renders, 0);
});

test("reviewed answer tampering is rejected before browser filling", async t => {
  const { service, calls } = await setup(t);
  const draft = await service.prepare("https://example.com/job");
  await service.store.update(draft.id, { answers: { years: "20" } });
  await assert.rejects(service.fill(draft.id), /current independent review/);
  assert.equal(calls.attachment, "");
});
