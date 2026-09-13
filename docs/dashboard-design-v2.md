# Dashboard v2 — design spec (Fable, 2026-08-07)

Adopts the strongest ideas from Friday's memory-dashboard brief on top of what's built.
Two surfaces, one philosophy: **main dashboard = mission control** (what is Henry doing),
**/memory Observatory = memory lab** (what does Henry know and why).

## A. Memory lab upgrades (/memory)
1. **Recall lab**: search box "recall a memory…" → POST `/api/engram/recall {query, k, store: personal|knowledge}` →
   returns ranked results with per-result `{score, lexical, semantic, activation, why}` from Engram's
   recallTrace + the activated node/edge ids. UI: the returned subgraph LIGHTS UP (seeds bright,
   activation-spread dimmer), non-matches fade; results panel lists each memory with its "why matched"
   explanation; clear-activation control. Read-only (`markUsed:false` from the lab — lab queries must
   not distort salience).
2. **Edge-type filter chips** (similar/temporal/about/caused/supersedes/lesson) + archived toggle.
3. **Store switch**: personal ⇄ knowledge (loads the matching graph + stats).

## B. Mission-control upgrades (/)
1. **Re-login button** (from the stalled spec): SSE carries `authAlert` (run.failed with
   metadata.authFailure in last 10min) → amber "⚠ <provider> logged out — Re-login" in the hero →
   POST /api/relogin opens Terminal pre-typed with the login command via osascript.
2. **Memory-health strip**: recall coverage, zero-result rate, p50/p95 latency, index freshness,
   last-dream time — from `/api/engram/metrics` (see C). Compact stat tiles, red when degraded.
3. **Knowledge panel**: per-domain counts + card count + distillation progress (from
   knowledge stats + cards checkpoint).

## C. Measurement layer (Friday's crown jewel, adapted)
- `src/metrics/recall-metrics.ts`: pure formulas + a JSONL event sink (`data/metrics/recall-events.jsonl`,
  timestamped, local-only). Instrument BOTH stores' recall(): emit {ts, store, query-hash (not raw text
  for personal), k, results, top score, latencyMs, engineError?}. **Engine failures tracked separately —
  never counted as zero-result recalls** (Friday's rule, non-negotiable).
- Metrics: healthy attempts, recall coverage, zero-result rate, avg returned, failure rate,
  p50/p95 latency, index freshness (db mtime vs newest source), enrichment coverage, orphan rate
  (nodes with no edges / all), duplicate rate (same-hash content), archive/promotion per dream.
- **Eval harness**: `data/eval/queries.json` (~15 seed queries with expected-module labels, grown over
  time) + `henry knowledge eval` → precision@5, MRR, per-query table. This gates any rerank/query-expansion
  investment (the reference production RAG's eval-first method).
- GET `/api/engram/metrics` aggregates the event log + live stats for panel B2.

## Constraints (unchanged doctrine)
127.0.0.1 only · visualization routes read-only · no external resources · no raw-HTML rendering of
memory text · page.ts inline-script edits demand extract+node--check · every panel fails soft.
