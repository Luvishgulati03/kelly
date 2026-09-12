import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import { assertNotLinkedInAutomation } from "./service.ts";
import { clearStaleProfileLocks } from "./scout.ts";
import type { JobApplicationDraft, JobPageSnapshot, JobQuestion, JobSource } from "./types.ts";

export interface BrowserFillResult {
  url: string;
  filled: string[];
  skipped: string[];
  screenshotPath?: string;
  verifiedValues?: Record<string, string>;
}

/**
 * Thrown when the submit control WAS clicked but no confirmation could be observed.
 * Distinct from every pre-click refusal, because the application may already be with the
 * employer: the caller must record uncertainty and refuse to retry, not mark it failed.
 */
export class SubmissionOutcomeUnknownError extends Error {
  readonly clicked = true;
  constructor() {
    super("Clicked submit but saw no confirmation — the application may or may not have been received; verify by hand before retrying");
    this.name = "SubmissionOutcomeUnknownError";
  }
}

/**
 * The form was not completely filled, and NOTHING was clicked. Retrying is safe here —
 * nothing reached the employer — but it is only *useful* when Henry actually had the
 * answer and failed to place it, which is what a late-hydrating ATS form looks like.
 * When the answer was never available, another attempt cannot invent it: that needs a
 * person, and `retryable` says so.
 */
export class FillIncompleteError extends Error {
  readonly clicked = false;
  constructor(readonly fields: string[], readonly withoutAnswers: string[], message?: string) {
    super(message ?? (withoutAnswers.length > 0
      ? `No answer is available for: ${withoutAnswers.join(", ")} — Henry will not guess; supply the fact and prepare again`
      : `Required fields were not filled; no submission was made: ${fields.join(", ")}`));
    this.name = "FillIncompleteError";
  }
  get retryable(): boolean { return this.withoutAnswers.length === 0; }
}

/**
 * The page is not shaped the way submission needs — e.g. two equally plausible final
 * buttons. Nothing was clicked, but retrying an unchanged page changes nothing: this is
 * the employer's site, so it goes to the operator rather than round a retry loop.
 */
export class SiteShapeError extends Error {
  readonly clicked = false;
  readonly retryable = false;
  constructor(message: string) { super(message); this.name = "SiteShapeError"; }
}

export interface BrowserSubmitResult {
  url: string;
  submittedAt: string;
  confirmationText: string;
}

export interface JobBrowser {
  inspect(url: string): Promise<JobPageSnapshot>;
  fill(url: string, draft: JobApplicationDraft): Promise<BrowserFillResult>;
  submit(url: string, draft: JobApplicationDraft): Promise<BrowserSubmitResult>;
}

function sourceFromUrl(url: string): JobSource {
  const host = new URL(url).hostname.toLowerCase();
  if (host.includes("linkedin.")) return "linkedin";
  if (host === "twitter.com" || host.endsWith(".twitter.com") || host === "x.com" || host.endsWith(".x.com")) return "twitter";
  return "generic";
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Runs in the page as well as through locator.evaluate; keep it self-contained.
function controlLabel(element: Element): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  const id = element.getAttribute("id");
  return (labelledBy?.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ")
    || element.getAttribute("aria-label")
    || Array.from((element as HTMLInputElement).labels || []).map((label) => label.textContent || "").join(" ")
    || (id ? Array.from(document.querySelectorAll("label")).filter((label) => label.htmlFor === id).map((label) => label.textContent || "").join(" ") : "")
    || "").replace(/\s+/g, " ").trim();
}

/** Only an unambiguous resume-labelled input may receive the resume. */
async function attachResume(page: Page, draft: JobApplicationDraft): Promise<boolean> {
  if (!draft.resumePdfPath) return false;
  const inputs = page.locator('input[type="file"]');
  const candidates = await inputs.evaluateAll((nodes) => nodes.map((node, index) => {
    const input = node as HTMLInputElement;
    const labelledBy = input.getAttribute("aria-labelledby");
    const label = (labelledBy?.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ")
      || input.getAttribute("aria-label")
      || Array.from(input.labels || []).map((item) => item.textContent || "").join(" ")
      || Array.from(document.querySelectorAll("label")).filter((item) => item.htmlFor === input.id).map((item) => item.textContent || "").join(" ")
      || "").replace(/\s+/g, " ").trim();
    const descriptor = [input.name, input.id, label].join(" ").toLowerCase();
    return /resume|résumé|\bcv\b|curriculum/i.test(descriptor) && !/cover|supporting|additional/i.test(descriptor) && !input.disabled ? index : -1;
  }).filter((index) => index >= 0));
  if (candidates.length !== 1) return false;
  const input = inputs.nth(candidates[0]!);
  try {
    await input.setInputFiles(draft.resumePdfPath, { timeout: 2_000 });
    return await input.evaluate((node) => (node as HTMLInputElement).files?.length === 1);
  } catch { return false; }
}

function usableAnswer(answer: string): boolean {
  return !!answer && !/^(unknown|unsure|n\/?a|none|tbd|todo|not (known|provided|specified|available|applicable)|select\b.*|choose\b.*|please select\b.*|[-–—.]+)$/i.test(answer)
    && !/^\[.*\]$|^\{\{.*\}\}$|^<.*>$/.test(answer);
}

async function fillQuestion(page: Page, question: JobQuestion, answer: string): Promise<string | null> {
  if (!usableAnswer(answer)) return null;
  // IDs are exact; label fallback must be unique, never a substring's first match.
  const byId = page.locator('[id]').filter({ visible: true });
  const matching = await byId.evaluateAll((nodes, id) => nodes.filter((node) => node.id === id).length, question.id);
  let control = page.getByLabel(question.label, { exact: true });
  if (matching === 1) control = page.locator(`[id=${JSON.stringify(question.id)}]`);
  if (await control.count() !== 1 || !await control.isVisible() || !await control.isEnabled()) return null;
  const info = await control.evaluate((node) => ({
    tag: node.tagName, type: (node as HTMLInputElement).type,
    role: node.getAttribute("role"),
    context: [node.getAttribute("aria-label"), node.closest("fieldset")?.textContent].join(" "),
  }));
  const label = await control.evaluate(controlLabel);
  if (/gender|\bsex\b|race|racial|ethnic|veteran|disabilit|sexual|religio|pronouns|self.identif|demographic/i.test(`${question.label} ${label} ${info.context}`)) return null;
  if (info.type === "file" || info.type === "hidden" || info.type === "submit" || info.type === "reset") return null;
  if (info.tag === "BUTTON" && info.type !== "button") return null;
  if (info.tag === "SELECT") {
    const options = await control.locator("option").evaluateAll((nodes, value) => nodes.filter((node) => {
      const option = node as HTMLOptionElement;
      return option.textContent?.trim() === value && !!option.value && !option.disabled && !(option.parentElement as HTMLOptGroupElement)?.disabled;
    }).map((node) => (node as HTMLOptionElement).value), answer);
    if (options.length !== 1) return null;
    await control.selectOption(options, { timeout: 2_000 });
    return await control.evaluate((node, value) => {
      const selected = Array.from((node as HTMLSelectElement).selectedOptions);
      return selected.length === 1 && selected[0]?.textContent?.trim() === value ? value : null;
    }, answer);
  }
  if (info.role === "combobox") {
    await control.click({ timeout: 2_000 });
    const listId = await control.getAttribute("aria-controls") || await control.getAttribute("aria-owns");
    if (!listId || listId.trim().split(/\s+/).length !== 1) return null;
    const list = page.locator(`[id=${JSON.stringify(listId)}]`);
    const option = list.getByRole("option", { name: answer, exact: true });
    try {
      await option.waitFor({ state: "visible", timeout: 2_000 });
      if (await option.count() !== 1 || !await option.isEnabled()) return null;
      // A role does not neutralize a button's default submit behaviour.
      if (await option.evaluate((node) => !!node.closest('button:not([type="button"]), input[type="submit"], a[href]'))) return null;
      await option.click({ timeout: 2_000 });
      const verified = await control.evaluate((node, value) => {
        const input = node as HTMLInputElement;
        // React Select / Greenhouse clears its search input after selection.
        const container = node.closest('[class*="control"]');
        const selected = container?.querySelector('[class*="singleValue"], [class*="single-value"]');
        return input.value === value || node.textContent?.trim() === value || selected?.textContent?.trim() === value ? value : null;
      }, answer);
      return verified || (await option.count() === 1 && await option.getAttribute("aria-selected") === "true" ? answer : null);
    } finally {
      // Escape closes an unselected popup without invoking implicit form submit.
      await control.press("Escape", { timeout: 2_000 }).catch(() => undefined);
    }
  }
  if (info.type === "checkbox") {
    if (!/^(yes|true|y|no|false|n)$/i.test(answer)) return null;
    const checked = /^(yes|true|y)$/i.test(answer);
    await control.setChecked(checked, { timeout: 2_000 });
    return await control.isChecked() === checked ? String(checked) : null;
  }
  if (info.tag !== "TEXTAREA" && !(info.tag === "INPUT" && /^(text|email|tel|url|search|number|date)$/.test(info.type))) return null;
  if (!await control.isEditable()) return null;
  await control.fill(answer, { timeout: 2_000 });
  return await control.inputValue() === answer ? answer : null;
}

async function fillFields(page: Page, draft: JobApplicationDraft): Promise<Pick<BrowserFillResult, "filled" | "skipped" | "verifiedValues">> {
  const filled: string[] = [];
  const skipped: string[] = [];
  const verifiedValues: Record<string, string> = {};
  for (const question of draft.posting.questions) {
    const answer = (draft.answers[question.id] ?? draft.answers[question.label] ?? "").trim();
    const verified = await fillQuestion(page, question, answer).catch(() => null);
    (verified ? filled : skipped).push(question.label);
    if (verified) verifiedValues[question.label] = verified;
  }
  if (draft.resumePdfPath) {
    const uploaded = await attachResume(page, draft);
    (uploaded ? filled : skipped).push("resume upload");
    if (uploaded) verifiedValues["resume upload"] = path.basename(draft.resumePdfPath);
  }
  return { filled, skipped, verifiedValues };
}

function skippedRequiredFields(draft: JobApplicationDraft, skipped: string[]): string[] {
  const skippedLabels = new Set(skipped);
  return draft.posting.questions.filter((question) => question.required && skippedLabels.has(question.label)).map((question) => question.label);
}

/**
 * Of the required fields that did not get filled, which ones did Henry actually have an
 * answer for? Those are worth another attempt — a form that hydrates late looks exactly
 * like this. The ones with no answer never will be: they need a person, not a retry.
 * Same lookup `fillFields` uses, so the two can never disagree about what an answer is.
 */
function requiredFieldsWithoutAnswers(draft: JobApplicationDraft, skipped: string[]): string[] {
  const skippedLabels = new Set(skipped);
  return draft.posting.questions
    .filter((question) => question.required && skippedLabels.has(question.label))
    .filter((question) => !(draft.answers[question.id] ?? draft.answers[question.label] ?? "").trim())
    .map((question) => question.label);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function rejectionOrValidationText(text: string): boolean {
  return /\b(application|resume|cv)\b[\s\S]{0,40}\b(was|were|is|has|have)?\s*not\s+(submitted|received|sent)\b/i.test(text)
    || /\b(not|unable to|could not|failed to|failure|error|invalid|required|missing|incomplete|please complete|please fill|fix the)\b/i.test(text);
}

function positiveConfirmationPhrase(text: string): string | null {
  const patterns = [
    /\byour application (has been |was )?(submitted|received|sent)\b/i,
    /\bapplication (has been |was )?(submitted|received|sent)\b/i,
    /\bwe (have )?received your application\b/i,
    /\bthank you for (applying|your application)\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

function clearSubmissionConfirmation(beforeText: string, afterText: string): boolean {
  const before = normalizeText(beforeText);
  const after = normalizeText(afterText);
  if (!after || after === before || rejectionOrValidationText(after)) return false;
  const phrase = positiveConfirmationPhrase(after);
  return !!phrase && !before.toLowerCase().includes(phrase.toLowerCase());
}

async function visibleText(page: Page, selectors: string[]): Promise<string> {
  const values = await page.locator(selectors.join(",")).allInnerTexts().catch(() => []);
  return values.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean).sort((a, b) => b.length - a.length)[0] || "";
}

async function extractSnapshot(page: Page): Promise<JobPageSnapshot> {
  const url = page.url();
  const pageTitle = await page.title();
  const title = (await page.locator("h1").first().textContent().catch(() => ""))?.trim()
    || (await page.locator('meta[property="og:title"]').getAttribute("content").catch(() => ""))?.trim()
    || pageTitle;
  const companyFromTitle = pageTitle.match(/\bat\s+(.+?)(?:\s*[|\-–—]\s*.*)?$/i)?.[1]?.trim() || "";
  const company = ((await visibleText(page, ["[class*='company' i]", "[data-testid*='company' i]"])) || companyFromTitle)
    .slice(0, 240);
  const description = (await visibleText(page, ["main article", "article", "[role='main']", "main", "body"]))
    .slice(0, 60_000);
  const questions: JobQuestion[] = [];
  const controls = page.locator('input, textarea, select, [role="combobox"]');
  for (let index = 0; index < await controls.count(); index += 1) {
    const control = controls.nth(index);
    if (!await control.isVisible()) continue;
    const label = await control.evaluate(controlLabel);
    if (!label) continue;
    const question = await control.evaluate((node, text) => {
      const element = node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (/^(file|hidden|submit|reset|button|image)$/.test(element.type)) return null;
      const combo = element.getAttribute("role") === "combobox";
      const kind = combo ? "single" : element.tagName === "TEXTAREA" ? "textarea" : element.tagName === "SELECT" ? ((element as HTMLSelectElement).multiple ? "multi" : "single") : element.type === "checkbox" ? "boolean" : "text";
      const options = element.tagName === "SELECT" ? Array.from((element as HTMLSelectElement).options).filter((option) => !!option.value && !option.disabled).map((option) => option.textContent?.trim() || "").filter(Boolean) : undefined;
      return { id: element.id || element.name || "", label: text, required: !!element.required || element.getAttribute("aria-required") === "true" || /\*\s*$/.test(text), kind, ...(options?.length ? { options } : {}) };
    }, label);
    if (question) questions.push({ ...question, id: question.id || `question-${index + 1}` } as JobQuestion);
  }
  return {
    url,
    title: title || "Untitled job",
    company: company || "Unknown company",
    description,
    questions,
    capturedAt: new Date().toISOString(),
  };
}

export class PlaywrightJobBrowser implements JobBrowser {
  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    private readonly contextFactory?: () => Promise<BrowserContext>,
  ) {}

  private async context(): Promise<BrowserContext> {
    if (this.contextFactory) return this.contextFactory();
    await fs.mkdir(this.config.browserProfileDir, { recursive: true, mode: 0o700 });
    await clearStaleProfileLocks(this.config.browserProfileDir);
    return chromium.launchPersistentContext(this.config.browserProfileDir, {
      headless: this.config.browserHeadless,
      viewport: { width: 1440, height: 1000 },
    });
  }

  async inspect(url: string): Promise<JobPageSnapshot> {
    const context = await this.context();
    try {
      const page = context.pages()[0] || await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      const snapshot = await extractSnapshot(page);
      await this.activity.record("job.discovered", `Inspected ${snapshot.title}`, { url: snapshot.url, source: sourceFromUrl(url), descriptionHash: hash(snapshot.description), questions: snapshot.questions.length });
      return snapshot;
    } finally { await context.close(); }
  }

  async fill(url: string, draft: JobApplicationDraft): Promise<BrowserFillResult> {
    assertNotLinkedInAutomation(url, "form-filling");
    const context = await this.context();
    try {
      const page = context.pages()[0] || await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      // Re-assert against the LIVE url (audit 2026-08-09 B-M13): an ATS link that
      // 302s to linkedin.com must hit the rail even though the stored URL passed.
      assertNotLinkedInAutomation(page.url(), "form-filling after redirect");
      const { filled, skipped, verifiedValues } = await fillFields(page, draft);
      const screenshotPath = path.join(this.config.dataDir, "job-browser", `${draft.id}-filled.png`);
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true, mode: 0o700 });
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await this.activity.record("job.filled", `Filled ${filled.length} application fields`, { applicationId: draft.id, skipped: skipped.length });
      return { url: page.url(), filled, skipped, screenshotPath, verifiedValues };
    } finally { await context.close(); }
  }

  async submit(url: string, draft: JobApplicationDraft): Promise<BrowserSubmitResult> {
    assertNotLinkedInAutomation(url, "submission");
    const context = await this.context();
    try {
      const page = context.pages()[0] || await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      assertNotLinkedInAutomation(page.url(), "submission after redirect");
      const { skipped } = await fillFields(page, draft);
      const requiredSkipped = skippedRequiredFields(draft, skipped);
      if (requiredSkipped.length > 0) throw new FillIncompleteError(requiredSkipped, requiredFieldsWithoutAnswers(draft, skipped));
      // The file exists — failing to attach it is a placement problem, not a missing fact,
      // so it is worth another attempt rather than the operator's attention.
      if (draft.resumePdfPath && skipped.includes("resume upload")) {
        throw new FillIncompleteError(["resume upload"], [], "Resume upload was not verified; no submission was made");
      }
      assertNotLinkedInAutomation(page.url(), "submission after redirect");
      const beforeSubmitText = await page.locator("body").innerText().catch(() => "");
      // Count the UNFILTERED locator (audit 2026-08-09 B-H7): counting after .first()
      // only ever sees 0 or 1, so the exactly-one guard on the irreversible click
      // never fired on ambiguous pages (sticky-footer Submit + in-form Submit).
      const candidates = page.getByRole("button", { name: /^(submit application|submit|send application)$/i });
      if (await candidates.count() !== 1) throw new SiteShapeError("Could not identify exactly one final application button; no submission was made");
      const submit = candidates.first();
      await submit.click();
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
      // Post-click teardown must not mark a REAL submission as failed (audit B-M10).
      const confirmationText = (await page.locator("body").innerText().catch(() => "")).slice(0, 2_000);
      // The click already happened, so "no confirmation" is NOT the same failure as the
      // pre-click refusals above: the employer may well have received this application.
      // Callers must be able to tell the two apart, or a retry double-submits.
      if (!clearSubmissionConfirmation(beforeSubmitText, confirmationText)) throw new SubmissionOutcomeUnknownError();
      const submittedAt = new Date().toISOString();
      await this.activity.record("job.submitted", `Submitted application for ${draft.posting.title}`, { applicationId: draft.id, url: page.url() });
      return { url: page.url(), submittedAt, confirmationText };
    } finally { await context.close(); }
  }
}
