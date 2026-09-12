import fs from "node:fs/promises";
import path from "node:path";
import type { HenryConfig } from "../config.ts";
import type { ProviderRunner } from "../providers/runner.ts";
import { runCommand } from "../util/command.ts";
import { distillToCards, type StrategyCard } from "./distill.ts";
import { chunkText, deriveDomain } from "./ingest.ts";
import type { KnowledgeBase, KnowledgeDomain } from "./store.ts";

const TEXT_EXTENSIONS = new Set([".md", ".txt"]);
const PDF_EXTENSION = ".pdf";
/** Directory recursion exclusions (spec'd): dotfiles/dot-dirs and node_modules. */
const SKIP_DIR_ENTRIES = new Set(["node_modules"]);

export interface ImportOptions {
  domain?: KnowledgeDomain;
  sourceName?: string;
  distill?: boolean;
  runner?: ProviderRunner;
}

export interface ImportReport {
  files: number;
  skipped: Array<{ path: string; reason: string }>;
  chunks: number;
  cards: number;
  byDomain: Record<string, number>;
}

/** Filesystem- and card-filename-safe label. Empty input falls through to the caller's date fallback. */
function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function fileBaseName(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

function firstHeading(text: string): string {
  return text.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim() || "";
}

/**
 * Recursively collects candidate files under `root` into `out`, skipping hidden
 * entries (dotfiles/dot-dirs, e.g. `.git`) and `node_modules`. Extension filtering
 * happens per-file in the caller so unsupported types still surface a skip reason
 * instead of silently vanishing.
 */
async function walk(root: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIR_ENTRIES.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

/** `pdftotext` (poppler) is the only PDF path — no pure-JS fallback bundled (M1 low-dependency policy). */
async function extractPdfText(filePath: string): Promise<{ text: string } | { error: string }> {
  const which = await runCommand("which", ["pdftotext"], process.cwd());
  if (which.exitCode !== 0) {
    return { error: "pdftotext not found on PATH (needed to read PDF sources). Install it with: brew install poppler" };
  }
  const result = await runCommand("pdftotext", [path.resolve(filePath), "-"], process.cwd());
  if (result.exitCode !== 0) {
    return { error: `pdftotext failed on ${path.basename(filePath)}: ${(result.stderr || "unknown error").trim().slice(0, 200)}` };
  }
  return { text: result.stdout };
}

function renderCard(card: StrategyCard): string {
  const steps = card.steps.map((step) => `- ${step}`).join("\n");
  const tags = card.tags.length ? `\n\n**Tags:** ${card.tags.join(", ")}` : "";
  return `## ${card.title}\n\n**Claim:** ${card.claim}\n\n**When to use:** ${card.whenToUse}\n\n${steps}\n\n**Evidence:** ${card.evidence}${tags}`;
}

/**
 * Generic knowledge importer: feeds arbitrary gathered material (articles, notes,
 * PDFs, folders of markdown) into the knowledge base — beyond the adapter-export shapes
 * `KnowledgeIngestor` (ingest.ts) expects. Reuses ingest.ts's chunking and domain
 * derivation so imported entries recall identically to natively-exported ones; never touches
 * ingest.ts's own collectRawEntries/ingestRaw/ingestCards paths (module doctrine #7).
 *
 * Originals are copied into `knowledge/raw/imported/<batch>/` for provenance (that
 * whole tree is gitignored, same as the rest of `knowledge/`). Raw chunks are always
 * indexed with local embeddings (free, zero provider calls); `options.distill`
 * additionally spends provider calls to derive strategy cards via the existing
 * `distillToCards` pipeline (distill.ts) — optional and clearly reported via `cards`.
 */
export async function importKnowledge(
  config: HenryConfig,
  kb: KnowledgeBase,
  sources: string[],
  options: ImportOptions = {},
): Promise<ImportReport> {
  const report: ImportReport = { files: 0, skipped: [], chunks: 0, cards: 0, byDomain: {} };

  const batchLabel = options.sourceName?.trim() || new Date().toISOString().slice(0, 10);
  const batchDir = slugify(batchLabel) || new Date().toISOString().slice(0, 10);
  const rawBatchDir = path.join(config.knowledgeDir, "raw", "imported", batchDir);
  const cardsDir = path.join(config.knowledgeDir, "cards");

  const files: string[] = [];
  for (const source of sources) {
    let stat;
    try {
      stat = await fs.stat(source);
    } catch {
      report.skipped.push({ path: source, reason: "not found" });
      continue;
    }
    if (stat.isDirectory()) await walk(source, files);
    else files.push(source);
  }

  let fileIndex = 0;
  for (const filePath of files.sort((a, b) => a.localeCompare(b))) {
    const ext = path.extname(filePath).toLowerCase();
    let text: string;
    if (TEXT_EXTENSIONS.has(ext)) {
      text = await fs.readFile(filePath, "utf8");
    } else if (ext === PDF_EXTENSION) {
      const extracted = await extractPdfText(filePath);
      if ("error" in extracted) {
        report.skipped.push({ path: filePath, reason: extracted.error });
        continue;
      }
      text = extracted.text;
    } else {
      report.skipped.push({ path: filePath, reason: ext ? `unsupported file extension "${ext}"` : "no file extension" });
      continue;
    }

    const base = fileBaseName(filePath);
    const heading = firstHeading(text);
    const pieces = chunkText(text);
    if (!pieces.length) {
      report.skipped.push({ path: filePath, reason: "empty after chunking (no usable text)" });
      continue;
    }

    fileIndex += 1;
    await fs.mkdir(rawBatchDir, { recursive: true, mode: 0o700 });
    await fs.copyFile(filePath, path.join(rawBatchDir, path.basename(filePath)));

    for (const [index, piece] of pieces.entries()) {
      const domain = options.domain ?? deriveDomain([path.basename(filePath), heading, piece]);
      const chunkSource = `imported/${batchDir}/${path.basename(filePath)}#${index + 1}`;
      await kb.add({
        content: `${base} (part ${index + 1})\n${piece}`,
        source: chunkSource,
        metadata: { layer: "raw", domain, module: base, source: chunkSource, imported: true, batch: batchLabel },
      });
      report.chunks += 1;
      report.byDomain[domain] = (report.byDomain[domain] || 0) + 1;
    }
    report.files += 1;

    if (options.distill && options.runner) {
      try {
        const domainHint = options.domain ?? deriveDomain([path.basename(filePath), heading, text]);
        const cards = await distillToCards(options.runner, { name: base, product: batchLabel, domainHint, text });
        if (cards.length) {
          await fs.mkdir(cardsDir, { recursive: true, mode: 0o700 });
          const cardFile = path.join(cardsDir, `imported-${batchDir}-${slugify(base) || "file"}-${fileIndex}.md`);
          const rendered = cards.map(renderCard).join("\n\n");
          await fs.writeFile(cardFile, `# ${base} — strategy cards (imported: ${batchLabel})\n\n${rendered}\n`, "utf8");
          for (const card of cards) {
            // distillToCards validates card.domain against KNOWLEDGE_DOMAINS internally
            // (distill.ts parseCards), so the cast is safe; an explicit options.domain still wins.
            const cardDomain = options.domain ?? (card.domain as KnowledgeDomain);
            await kb.add({
              content: `${card.title}\n${card.claim}\nWhen to use: ${card.whenToUse}\nSteps: ${card.steps.join("; ")}\nEvidence: ${card.evidence}`,
              source: `imported/cards/${path.basename(cardFile)}`,
              importance: 8,
              metadata: { layer: "card", domain: cardDomain, module: base, imported: true, batch: batchLabel, tags: card.tags },
            });
            report.cards += 1;
          }
        }
      } catch {
        // Fail-open (module doctrine #6): a distillation hiccup on one file never drops
        // the raw indexing that already succeeded for it, nor aborts the rest of the batch.
      }
    }
  }

  return report;
}
