# Build a knowledge RAG for your agent — executable guide

**You are a coding agent (Claude Code, Codex, or similar) reading this inside a fork of
this repository, or inside any agent project you're extending.** This guide teaches you to
build the same knowledge system this repo runs: a local-first RAG that turns any corpus
your operator provides (course transcripts, internal docs, gathered research, books,
notes) into grounded, cited answers. Don't invent a different design — this one's
decisions were tuned against a production RAG's published evaluation findings and an
eval harness. Follow the steps; verify each before moving on.

## The architecture you are building

```
operator's corpus (md/txt/pdf/exports)          ← files are the source of truth
   │  1. chunk (inherit good chunks if they exist; else ~1.4k chars, sentence-aware)
   │  2. contextual prefix: "<doc/module title> (part n)\n" prepended to EMBEDDED text
   │  3. embed LOCALLY (bge-small-en-v1.5 q8 via transformers.js — 384d, ~10ms, $0)
   ▼
SQLite index (this repo uses engram-memory: vectors + FTS5 + associative graph)
   │  4. optional: distill each document into STRATEGY CARDS via a provider CLI call
   │     (atomic units: claim · when-to-use · steps · evidence · source) — cards are
   │     your precision layer; raw chunks are your depth layer
   ▼
retrieval (LLM-free, ~100-400ms)
   │  5. hybrid: vector cosine + full-text, fused (reciprocal rank)
   │  6. + spreading activation over graph edges (associative recall)
   │  7. discipline filters — the part most RAGs get wrong (see below)
   ▼
injection into the agent's prompt, labeled + grounded (see step 8)
```

## Retrieval discipline (non-negotiable rules, learned from production evals)

1. **Score threshold beats pure top-K.** Never pad to k with weak hits — distractors
   actively hurt answer quality. Calibrate the floor on YOUR fused-score scale
   empirically (this repo: 0.02 fused ≈ a 0.70 cosine cut in the reference system).
2. **Cap results per source document** (2 here) — context diversity beats depth.
3. **Domain/audience tags BOOST ranking; they never hard-filter.** Hard filters create
   blind spots (adjacent-domain content answering the question). This repo: ×1.5 boost.
4. **Cards vs raw: interleave by score with a card multiplier — never absolute
   cards-first.** Absolute priority structurally buries newly imported material. Tune
   the multiplier with your eval set (this repo swept 1.15/1.5/2.0/3.0 → 2.0 kept full
   precision while letting strong raw hits surface).
5. **Contextual prefixes on embeddings** (title + part), raw text stored for display.

## Build steps

1. **Store**: instantiate a second engram instance (or equivalent) at its own db path —
   NEVER share the personal-memory store; knowledge is versioned and source-attributed,
   it does not decay or supersede. Wire a local `EmbeddingProvider` (see
   `src/embeddings.ts` here) — do not default to hashing embeddings; they are
   semantically blind.
2. **Importer**: a CLI (`knowledge add <path> [--domain] [--name] [--distill]`) that
   accepts md/txt/pdf files or folders, copies originals under
   `knowledge/raw/imported/<batch>/` (provenance), chunks, prefixes, embeds, indexes
   with metadata `{layer:"raw", domain, module, source, batch}`. Free — no provider
   calls. Keep `knowledge/` and the db gitignored: the operator's corpus is theirs.
3. **Cards (optional but recommended)**: one provider-CLI call per document — "distill
   into 3-8 atomic strategy cards, JSON, never invent, quote-derived evidence" — write
   cards as markdown files AND index them with `layer:"card"`, higher importance.
   Checkpoint the batch (a JSON of done-ids) so distillation is resumable; run it in
   bounded concurrent rounds, not one giant call.
4. **Domain routing**: a zero-LLM gate decides IF knowledge is injected — but don't gate
   on keywords alone: any substantive turn (not smalltalk) gets a cheap retrieval PROBE,
   and the corpus's own relevance scores decide. Chatter never pays the retrieval tax.
5. **Grounding rule**: when a knowledge block is injected, prepend a directive: ground
   the answer in it, CITE source/module names, and explicitly label anything beyond the
   corpus as general knowledge — never blend silently. This is what makes the RAG the
   brain rather than a suggestion.
6. **Self-capability**: teach the agent's own system prompt that the importer exists, so
   the operator can say "learn this folder" in plain language and the agent runs the
   command itself (derive the batch name, pick the domain, pass --distill only on
   explicit request).
7. **Eval harness before any tuning**: ~12-30 real queries with expected-source labels →
   precision@5 + MRR, run via the REAL retrieval pipeline (read-only: recall must not
   reinforce/markUsed during eval). Record a baseline; every ranking change re-runs it.
   Track engine failures SEPARATELY from zero-result recalls — infrastructure errors
   must never masquerade as poor memory quality.
8. **Metrics**: log every recall (store, hashed query, k, results, top score, latency,
   engineError?) to a local JSONL; summarize coverage / zero-result rate / p50/p95 /
   index freshness on your dashboard.

## Acceptance criteria (verify all before declaring done)

- A fresh corpus folder imports with one command; its chunks surface in search with
  correct provenance and participate in answers with citations.
- Ask the agent an in-corpus question: the answer cites sources. Ask an out-of-corpus
  question: the agent says the corpus doesn't cover it.
- Eval baseline recorded; a deliberate ranking change shows a measurable delta.
- The corpus directory and db are gitignored; `git ls-files` shows no operator content.
- Retrieval stays LLM-free and sub-second; injection respects a char budget (~6k).
