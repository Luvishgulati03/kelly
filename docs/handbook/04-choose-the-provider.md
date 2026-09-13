# Stage 4: BUILDING - Reminder Module Walkthrough

Goal: learn how a real Henry module is documented, wired, and verified without
inventing a second implementation path.

## Do

Open the BUILDING template:

```bash
sed -n '1,260p' docs/handbook/BUILDING.md
```

Walk the reminders module:

```bash
sed -n '1,220p' docs/modules/reminders.md
sed -n '1,240p' src/reminders/service.ts
sed -n '1,180p' src/reminders/ticker.ts
rg -n "command === \"remind\"|remind list|remind cancel|execute-approval" src/cli.ts tests/reminders.test.ts
```

Try the CLI in a private setup:

```bash
henry remind "check the handbook" --in "10m"
henry remind list
henry remind cancel <id>
```

Run the focused tests for this module:

```bash
npx tsx --import ./tests/isolate.mjs --test-concurrency=1 --test tests/reminders.test.ts
```

## Check

The real command surface is:

```text
henry remind "<text>" --at "YYYY-MM-DD HH:mm"
henry remind "<text>" --in "2h"
henry remind "<text>" --every "<cron>"
henry remind --prompt "<instruction>" --at|--in|--every|--random-daily ...
henry remind --execute-approval <approvalId> --at "YYYY-MM-DD HH:mm"
henry remind list
henry remind cancel <id>
```

The implementation stores reminders under `data/reminders.json`, starts a ticker
inside long-lived processes, and executes scheduled outbound sends only through
an already-approved approval item.

## Learn

This is the pattern to copy: guide-executable docs, one CLI surface, real tests,
runtime wiring, fail-soft notification behavior, and no special model path. The
module changes timing, not authority.

## Build Your First Custom Module

Copy [BUILDING.md](BUILDING.md) into a private working note and define one
narrow use case. A complete Henry module normally has these layers:

1. `src/<module>/service.ts` owns domain behavior and accepts dependencies.
2. `src/config.ts` reads optional configuration without hard-coded personal data.
3. `src/runtime.ts` constructs the service once and shares kernel dependencies.
4. `src/cli.ts` exposes one truthful command surface.
5. `src/types.ts` adds activity or approval kinds only when required.
6. `tests/<module>.test.ts` proves success, failure, and safety boundaries.
7. `docs/modules/<module>.md` explains configuration, verification, and disablement.

If the feature only reads or changes local state, keep it local. If it sends,
posts, merges, submits, pays, or otherwise changes external state, stage an
exact approval payload first and execute only after a separate approval claim.
Prompts may explain that policy; code must enforce it.

Finish a module with:

```bash
npx tsc --noEmit
npx tsx --import ./tests/isolate.mjs --test-concurrency=1 --test tests/<module>.test.ts
npm test
git diff --check
```

## Record

```md
Module inspected:
CLI branch:
Runtime/ticker path:
Storage path:
Focused test:
Approval behavior:
New module use case:
Expected files:
Disable/rollback path:
```

---

Previous: [Stage 3: Soul And Personality](03-shape-the-agent.md) | Next: [Stage 5: Memory Vs Knowledge](05-talk-to-henry.md)
