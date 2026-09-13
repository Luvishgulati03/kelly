# Stage 9: Extend And Review Safely

Goal: make future Henry changes with bounded scope, verified behavior, and no
approval bypass.

## Do

Read the core design docs:

```bash
sed -n '1,260p' docs/architecture.md
sed -n '1,220p' docs/module-doctrine.md
```

Use Henry for local engineering tasks:

```bash
henry task "inspect this repo and summarize the smallest safe implementation path" --cwd /path/to/repo
```

Use the review path for pull requests:

```bash
henry pr review 123 --repo owner/repository --cwd /path/to/repo
henry pr merge 123 --repo owner/repository --cwd /path/to/repo --check "npm test" --verify "npm run build" --method squash
henry approve list
```

## Check

The review commands in `src/cli.ts` are:

```text
henry pr review|merge <pr-number-or-url> [--cwd path] [--repo owner/name]
henry review <pr-number-or-url> [--cwd path] [--repo owner/name]
```

The approval commands are:

```text
henry approve list|approve|send <id>
```

`docs/modules/pr-review.md` requires six passes: logic, safety, product thinking,
query performance, consistency, and surface.

## Learn

Keep implementation additive. Use existing config, runtime, provider runner,
memory, activity, scheduler, and approval interfaces. Parallelize only independent
investigation. Shared-file implementation should be sequential or isolated.

For read-only external tools, MCP can be appropriate. For anything that writes,
sends, posts, pays, deletes, or changes external state, build or use a Henry
approval path.

## Record

```md
Change:
Owned paths:
Existing dirty files:
Runtime hook:
Approval kind:
Focused tests:
Typecheck:
Full tests:
Final status:
Residual risk:
```

---

Previous: [Stage 8: Troubleshooting](08-automate-carefully.md) | Next: [Handbook README](README.md)

