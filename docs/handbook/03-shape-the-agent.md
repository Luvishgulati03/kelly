# Stage 3: Soul And Personality

Goal: separate hard operating rules from voice and preferences.

## Do

Read the persona guide and examples:

```bash
sed -n '1,220p' docs/design-your-soul.md
sed -n '1,260p' docs/persona-design-guide.md
sed -n '1,180p' soul.example.md
sed -n '1,180p' personality.example.md
```

If this is a published fork, also read the explicit rename guide:

```bash
sed -n '1,260p' docs/rename-your-agent.md
```

It distinguishes a private persona rename from a complete product rebrand of
the CLI, dashboard, environment prefix, package, documentation, and code symbols.

For a private setup, create local persona files:

```bash
cp soul.example.md soul.md
cp personality.example.md personality.md
```

Verify they exist locally:

```bash
test -f soul.md && test -f personality.md && echo ok
```

## Check

Use `soul.md` for non-negotiables: identity, approval boundaries, and channel
rules. Use `personality.md` for style, judgment preferences, and memory habits.

The shipped examples name this repository's original operator. A fork should
replace those local persona files with the new user's own terms, while keeping
the outbound approval rule intact.

Before the first personal conversation, replace every example value for:

- agent name and how it addresses you;
- your preferred tone, decision style, and interruption policy;
- what deserves durable memory and what must never be retained;
- which local folders and accounts are in scope;
- channel rules for terminal, dashboard, Telegram, email, and social actions;
- the non-negotiable rule that drafting, approval, and execution are separate.

Use the public question bank in `docs/persona-design-guide.md`. Ask a relevant
12–20 questions in short conversational rounds; do not dump all 63 questions on
the user or infer a psychological profile.

Confirm the private files cannot be committed:

```bash
git check-ignore soul.md personality.md .env data memory knowledge
git status --short
```

Do not copy secrets, tokens, resume data, private memories, or a proprietary
knowledge corpus into a public fork.

## Learn

Persona files are injected into provider calls, so they should be short and
specific. Do not soften a hard rule into "use judgment." If a new channel can
send outward, extend the hard rule to name that channel.

## Record

```md
Agent name:
User term of address:
Hard outbound rule:
Voice preferences:
Memory preferences:
```

---

Previous: [Stage 2: IDEATION](02-install-and-verify.md) | Next: [Stage 4: BUILDING](04-choose-the-provider.md)
