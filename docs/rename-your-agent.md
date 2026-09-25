# Rename Henry for your own agent

> Kelly is itself an option-B rebrand of Henry: the `kelly` command, the `KELLY_`
> prefix, and profile-based service composition in `src/profile.ts`. Use it as a
> worked example; the commands below keep Henry's original names.

There are two different kinds of rename. Choose one deliberately instead of
blindly replacing every occurrence of `Henry` and hoping TypeScript enjoys the
surprise.

## Option A: rename the personality only

Use this when you want your agent to introduce itself with a new name while
keeping the framework, `henry` terminal command, `HENRY_` configuration prefix,
and upstream compatibility.

1. Create the private persona files:

   ```bash
   cp soul.example.md soul.md
   cp personality.example.md personality.md
   ```

2. Replace `<AgentName>` and `<Operator>` in those two private files. Keep the
   outbound approval language intact.
3. Answer the interview in
   [`persona-design-guide.md`](persona-design-guide.md), then add only the
   durable conclusions to `soul.md` and `personality.md`.
4. Verify the files remain private:

   ```bash
   git check-ignore soul.md personality.md
   henry ask "What is your name, what should you call me, and what actions need approval?"
   ```

This changes the provider persona. Some framework UI labels and command examples
will still say Henry because they describe the underlying product.

## Option B: completely rebrand a fork

Use this when you are publishing a separate agent product with its own command,
dashboard name, environment prefix, documentation, and repository identity.
Do this on a new branch and keep the rename as its own commit.

### 1. Decide the complete naming map

Write these values down before editing:

```text
Product name:        Nova
CLI command:         nova
Environment prefix: NOVA_
Runtime class name:  NovaRuntime
Operator term:       Alex
Repository name:     nova-agent
```

The product name, command, environment prefix, and TypeScript class names are
different identifiers. Do not use a display name containing spaces as a CLI
command or environment prefix.

### 2. Rename user-facing identity

Update the private `soul.md` and `personality.md` first. Then update public
labels in:

- `README.md`, `SETUP.md`, `BOOTSTRAP.md`, and `docs/`;
- `src/dashboard/` page titles, headings, accessibility labels, and messages;
- `src/agent/henry.ts` provider instructions;
- notification titles and Telegram-facing copy.

Search before and after:

```bash
rg -n "Henry|henry|HENRY_|<OldOwnerName>" --glob '!node_modules/**' --glob '!data/**' --glob '!memory/**'
```

Replace `<OldOwnerName>` with the previous owner's name, if the fork inherited one.
Review every match. Some historical migration notes or attribution may
legitimately retain the original name.

### 3. Rename the executable and package

Update `package.json`:

```json
{
  "name": "nova-agent",
  "bin": {
    "nova": "./bin/nova.mjs"
  }
}
```

Rename `bin/henry.mjs` to the selected launcher name and update any launcher
references in scripts, tests, setup instructions, and scheduled-service files.
Run `npm install` so `package-lock.json` reflects the new package and binary.
Then run `npm link` to register the new command.

### 4. Rename configuration deliberately

The public framework currently reads the `HENRY_` prefix in `src/config.ts`.
For a complete rebrand, change that prefix and update `.env.example`, tests,
workflow installers, launchd labels, and documentation together. During a
migration, consider reading both prefixes temporarily so existing installations
do not silently lose configuration.

Never rename or commit the contents of `.env`, `data/`, `memory/`, `knowledge/`,
browser profiles, credentials, or tokens. Those are private deployment data,
not branding assets.

### 5. Rename code symbols last

Renaming classes such as `HenryRuntime`, `HenryAgent`, and `HenryConfig` is
optional. It improves product consistency but does not change runtime behavior.
Use the TypeScript language service or a symbol-aware rename, not unrestricted
text replacement. Rename one symbol at a time and review imports after each
change.

### 6. Verify the rebrand

```bash
npm run typecheck
npm test
npm link
nova status
nova ask "State your name and hard approval boundary in two sentences."
rg -n "Henry|henry|HENRY_|<OldOwnerName>" --glob '!node_modules/**' --glob '!data/**' --glob '!memory/**'
git diff --check
git status --short
```

Inspect the terminal, dashboard, web chat, Telegram replies, notifications, help
text, scheduler installation, and a fresh-clone setup. A rename is complete only
when the old command is no longer required, the new environment prefix works,
private files remain ignored, and the outbound approval tests still pass.

## Guidance for coding agents

When helping someone rebrand a fork:

1. ask for the naming map above;
2. inspect all current matches before editing;
3. preserve safety and approval behavior exactly;
4. never copy the original operator's private persona or data;
5. perform the rename in reviewable commits;
6. run the full verification list and report remaining old-name matches.
