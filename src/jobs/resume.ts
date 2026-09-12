import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

export type ResumeRenderer = (markdown: string, outputPath: string) => Promise<string>;

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

/**
 * Renders the resume subset of Markdown: headings, bullet lists, bold, italic,
 * links, horizontal rules, and paragraphs. Input is escaped before transforms,
 * so resume content can never inject markup into the PDF template.
 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const html: string[] = [];
  let inList = false;
  const closeList = (): void => { if (inList) { html.push("</ul>"); inList = false; } };
  for (const raw of lines) {
    const line = escapeHtml(raw.trimEnd());
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) { closeList(); html.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); continue; }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { closeList(); html.push("<hr>"); continue; }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) { if (!inList) { html.push("<ul>"); inList = true; } html.push(`<li>${inline(bullet[1])}</li>`); continue; }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    html.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return html.join("\n");
}

const RESUME_CSS = `
  @page { margin: 14mm 15mm; }
  * { box-sizing: border-box; }
  body { font: 10.5pt/1.45 "Helvetica Neue", Helvetica, Arial, sans-serif; color: #1a1f2b; margin: 0; }
  h1 { font-size: 20pt; margin: 0 0 2pt; letter-spacing: .01em; }
  h2 { font-size: 11.5pt; text-transform: uppercase; letter-spacing: .09em; color: #24407a; border-bottom: 1.2px solid #24407a; padding-bottom: 2pt; margin: 14pt 0 6pt; }
  h3 { font-size: 10.8pt; margin: 8pt 0 2pt; }
  h4 { font-size: 10pt; color: #4a5468; margin: 0 0 2pt; font-weight: 500; }
  p { margin: 0 0 5pt; }
  ul { margin: 2pt 0 7pt; padding-left: 14pt; }
  li { margin-bottom: 2.5pt; }
  a { color: #24407a; text-decoration: none; }
  hr { border: 0; border-top: 1px solid #ccd2de; margin: 8pt 0; }
`;

export async function renderResumePdf(markdown: string, outputPath: string): Promise<string> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${RESUME_CSS}</style></head><body>${markdownToHtml(markdown)}</body></html>`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({ path: outputPath, format: "A4", printBackground: true });
  } finally { await browser.close(); }
  return outputPath;
}
