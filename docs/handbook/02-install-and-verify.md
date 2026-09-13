# Stage 2: IDEATION

Goal: decide what Henry should do before deciding what to build.

## Do

Open the fill-in template:

```bash
sed -n '1,240p' docs/handbook/IDEATION.md
```

Read the module contract:

```bash
sed -n '1,180p' docs/architecture.md
sed -n '1,220p' docs/module-doctrine.md
```

Create a local planning note outside the public docs when working on a real
change, then answer the template prompts there. Do not put private user facts or
credentials into the handbook.

## Check

A good ideation pass answers:

- What problem is being solved?
- Which existing command, module, or doc is closest?
- What is in scope and out of scope?
- Whether the feature can send, post, message, pay, delete, or change external
  state.
- What concrete artifact proves success.

## Learn

Henry changes should start from the existing kernel and module surface. A feature
that needs only configuration should not become new code. A feature that writes
outside the laptop needs an approval item and executor, not just prompt text.

## Record

```md
Template completed:
Closest existing module:
Outbound risk:
Verification artifact:
Decision:
```

---

Previous: [Stage 1: Welcome And Laptop Setup](01-open-the-repo.md) | Next: [Stage 3: Soul And Personality](03-shape-the-agent.md)

