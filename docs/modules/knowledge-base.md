# Module: knowledge base

**You are Claude Code, Codex, or another coding agent, reading this inside
Henry's repo.** Already implemented at `src/knowledge/store.ts`,
`src/knowledge/ingest.ts`, `src/knowledge/router.ts`, and
`src/knowledge/adapters/org-mongo.ts` — don't rebuild it. Configure and verify
only.

## 1. What it does

A second, on-demand RAG store — deliberately separate from personal memory
(`src/memory/engram.ts`): versioned and source-attributed, no decay/supersede
lifecycle, injected only when a domain is detected in the prompt rather than
every turn. It's a second `Engram` instance (`src/knowledge/store.ts`) pointed
at its own SQLite file, using the same local (no-API-key) embeddings as
personal memory.

Commands it adds (`src/cli.ts`, `knowledge` branch):

```
henry knowledge export                    # optional: pulls a compatible raw corpus from a configured Mongo instance
henry knowledge index [--limit N]         # indexes knowledge/raw/{chunks.jsonl,transcripts/,texts/} with LOCAL embeddings, zero LLM calls
henry knowledge distill [--limit N]       # LLM pass: raw chunks -> strategy cards (provider call per module, budgeted)
henry knowledge search <query> [--domain gtm]
henry knowledge context <query> [--domain gtm]
henry knowledge stats
```

## 2. Configure

Env keys (`.env`, read by `src/config.ts`):

```
HENRY_KNOWLEDGE_DIR=knowledge   # default shown; holds raw/ and cards/
```

No API key is required for `index`/`search`/`context`/`stats` — embeddings are
local (`LocalEmbeddingProvider`). `distill` makes provider CLI calls (subscription
auth, not a paid API), same as the rest of Henry.

**Accuracy note on the corpus shape**: `henry knowledge index` does NOT ingest
arbitrary markdown. `KnowledgeIngestor.collectRawEntries()` reads exactly:
- `knowledge/raw/chunks.jsonl` — one JSON object per line with a `text` or
  `content` field (plus optional `module_id`, `chapter_title`,
  `teaches_concepts`, `difficulty`).
- `knowledge/raw/transcripts/*.md` and `knowledge/raw/texts/*.md` — markdown
  with a `key: value` frontmatter block (a `module:` field at minimum).

`henry knowledge export` is an optional adapter for a compatible Mongo instance.
It reads credentials from `ORG_BACKEND_DIR/apps/migrations/.env` and writes the
corpus above into `knowledge/raw/`. Collection names default to `modules`,
`learningchunks`, and `awsmediajobs`; deployments can override them with
`HENRY_KNOWLEDGE_MODULES_COLLECTION`, `HENRY_KNOWLEDGE_CHUNKS_COLLECTION`, and
`HENRY_KNOWLEDGE_TRANSCRIPTS_COLLECTION`. Forks without a compatible Mongo source
should use `henry knowledge add <file-or-folder>` instead.

## 3. How it wires to the brain

- **Not** memory (Engram personal store) — a second, independent `Engram`
  instance with its own DB file (`data/knowledge.db`), by design (§ module
  contract in `docs/architecture.md`).
- **Provider runner**: only `distill` calls the provider CLI
  (`src/knowledge/ingest.ts`, `ingestCards`), budgeted per run and
  checkpointed so it never re-distills a module twice.
- **Injected into the main agent automatically**: `HenryAgent.buildPrompt()`
  (`src/agent/henry.ts`) calls `detectKnowledgeDomain(prompt)`
  (`src/knowledge/router.ts`); if a domain is detected, it pulls up to 6000
  chars of context from the knowledge base and appends it to the prompt
  labeled `--- Curated knowledge (tried & tested playbooks) ---` — no
  CLI command needed for this path, it's automatic per turn.
- **Scheduler**: `workflows/defaults.json` ships
  `knowledge-distill-nightly` (`kind: "knowledge.distill"`, `batchLimit: 25`,
  cron `0 2 * * *`) — **enabled by default**. It runs through
  `WorkflowScheduler.runKnowledgeDistill()` (`src/scheduler/scheduler.ts`),
  which takes a pid-lock file (`data/knowledge.lock`) so an overlapping manual
  run never collides with the nightly one.

## 4. Verify

```bash
npx tsx src/cli.ts knowledge stats        # { ...engram stats... } — works even with zero entries
npx tsx src/cli.ts knowledge index --limit 10
# → { entries, skipped, byDomain }   (0 entries if knowledge/raw/ is empty — not an error)
npx tsx src/cli.ts knowledge search "GTM strategies for B2B SaaS" --domain gtm
# → [{ score, source, content }]  — empty array is valid if nothing is indexed yet
npx tsx src/cli.ts knowledge context "onboarding playbook"
# → a formatted context block, or "" if nothing cleared the score threshold
```

## 5. Disable

`KnowledgeBase` is constructed lazily (`runtime.get knowledge()` in
`src/runtime.ts`) — it is **not** opened at boot, only on first `henry
knowledge ...` call or the first domain-matched agent turn. To keep it fully
dormant: never run `henry knowledge` commands, and disable the scheduled
distillation by setting `"enabled": false` on the `knowledge-distill-nightly`
entry in `workflows/defaults.json`. No env var is required to turn it off.

## 6. Adding your own knowledge

The accuracy note in §2 still holds for `henry knowledge index` — but you are
not limited to the adapter's export shape. `src/knowledge/importer.ts`
(`importKnowledge`) is a second, generic ingestion path for arbitrary
gathered material: articles, notes, PDFs, or whole folders of markdown, e.g.
"marketing techniques for small startups" clipped from wherever you found it.

```
henry knowledge add <path> [--domain gtm|growth-strategy|product-management|software-development|community|sales|careers|general] [--name <batch-name>] [--distill]
```

- `<path>` is a single file or a directory. Directories are walked
  recursively; hidden entries (dotfiles/dot-directories) and `node_modules`
  are skipped.
- Supported files: `.md` and `.txt` are read directly; `.pdf` is extracted
  via `pdftotext` (poppler) if it's on PATH — install with `brew install
  poppler` if you see that error. Any other extension is skipped with a
  reason in the report, not silently dropped.
- `--domain` pins every chunk (and, by default, every distilled card) to one
  domain instead of the automatic per-chunk heuristic (`deriveDomain`, the
  same one `henry knowledge index` uses).
- `--name <batch-name>` labels the import (defaults to today's date if
  omitted) — it becomes the provenance folder name and `metadata.batch` on
  every indexed entry, so keep it meaningful; there is no delete/undo command
  yet, so a sloppy name just sits there harmlessly.
- `--distill` additionally spends provider calls (`distillToCards`,
  `src/knowledge/distill.ts`) to turn each file into strategy cards, on top
  of the raw indexing that always happens for free (local embeddings only).
  Omit it for a zero-cost import.

Where things land: originals are copied to
`knowledge/raw/imported/<batch>/` (provenance; gitignored, same as the rest
of `knowledge/`); raw chunks are indexed straight into `data/knowledge.db`
with `metadata.layer = "raw"` and `metadata.imported = true`; cards (only
with `--distill`) are rendered to
`knowledge/cards/imported-<batch>-<file>-N.md` and indexed with
`metadata.layer = "card"`. Both layers recall through the normal `henry
knowledge search|context` commands alongside the adapter's native content — imported
entries are just additional rows, not a separate store.
