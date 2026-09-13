# Stage 5: Memory Vs Knowledge

Goal: use the right retrieval store for the right kind of information.

## Do

Read the architecture and knowledge docs:

```bash
sed -n '100,150p' docs/architecture.md
sed -n '1,240p' docs/modules/knowledge-base.md
```

Inspect personal memory:

```bash
henry memory search "preferences"
henry memory graph
```

Inspect the knowledge store:

```bash
henry knowledge stats
henry knowledge search "planning guidance" --domain project-management
henry knowledge context "planning guidance"
```

Add knowledge only from a source you are allowed to store locally:

```bash
henry knowledge add /path/to/notes --domain project-management --name handbook-test
```

## Check

Memory commands in `src/cli.ts`:

```text
henry memory search|remember|index|graph|dream
```

Knowledge commands in `src/cli.ts`:

```text
henry knowledge export|index|distill|add|search|context|eval|stats
```

## Learn

Personal memory captures durable user preferences, decisions, corrections, and
commitments. It decays, promotes, supersedes, consolidates, and is injected under
a budget.

Knowledge is a separate, source-attributed corpus for reusable domain material.
It does not decay and is injected only when the prompt routes to a relevant
domain or when explicitly queried.

Examples:

- “Prefer concise morning updates” is personal memory.
- A product-management book or engineering playbook is knowledge.
- A one-off secret or access token belongs in neither store.

Durable source material lives under the gitignored `memory/` and `knowledge/`
directories. Rebuildable indexes and operational state live under `data/`,
including Engram and knowledge SQLite databases. Treat all three locations as
sensitive local data. Before indexing a file, confirm you have the right to
store it and understand that extracted text and embeddings remain on disk until
you deliberately remove/rebuild that local store.

## Record

```md
Memory query:
Useful memory:
Knowledge domain:
Knowledge source:
Search result:
Store chosen and why:
```

---

Previous: [Stage 4: BUILDING](04-choose-the-provider.md) | Next: [Stage 6: Grow Through Surfaces, Schedules, And Approval](06-use-memory.md)
