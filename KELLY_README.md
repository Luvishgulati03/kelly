# Kelly — Electrical Shop Quotation Assistant

Kelly is a local-first personal quotation assistant for electrical shops, built on Henry's shared architecture.

## What Kelly Does

Kelly helps you generate, organize, and manage electrical shop quotations with:

- **Quotation generation** from customer requirements
- **Provider integration** support (Claude/Codex)
- **Memory system** to learn from past quotations
- **Activity logging** and approval workflows
- **Terminal interface** with REPL mode
- **Dashboard** for monitoring
- **Reminders** and scheduled tasks
- **Telegram notifications** (optional)

## What Kelly Does NOT Do

Kelly is a focused assistant; it intentionally excludes:

- Gmail integration
- Job application management
- Resume/cover letter generation
- Meeting transcription
- Screenshot sorting
- Social media posting (LinkedIn, X/Twitter)
- Mailwatch/job tracking
- Launch/product management
- Standup/team coordination

These services are available in Henry if you need a full personal engineering agent.

## Installation

```bash
npm install
cp .env.example .env
cp soul.example.md soul.md
cp personality.example.md personality.md
claude auth login
npx tsx src/cli.ts provider claude
npx tsx src/cli.ts repl
```

Or with npm link:

```bash
npm link
kelly repl
```

## Configuration

Kelly uses `KELLY_` prefixed environment variables and maintains its own isolated data directory:

```bash
# .env
KELLY_DATA_DIR=data/kelly
KELLY_MEMORY_DIR=memory/kelly
KELLY_HOST=127.0.0.1
KELLY_PORT=7338
KELLY_PROVIDER=claude
KELLY_TELEGRAM_BOT_TOKEN=your_token
KELLY_TELEGRAM_CHAT_ID=your_chat_id
```

## Running Kelly

### Interactive REPL

```bash
kelly repl
```

The dashboard is available at `http://127.0.0.1:7338` by default.

### Single Query

```bash
kelly ask "Generate a quotation for 100 LED bulbs at ₹50 each"
```

### Dashboard Only

```bash
kelly dashboard
```

### Memory Management

```bash
kelly memory search "recent quotations"
kelly memory remember "standard markup is 30%"
```

### Approvals

Kelly stages outbound actions (if enabled) for approval:

```bash
kelly approve list
kelly approve approve <approval-id>
kelly approve send <approval-id>
```

### Reminders and Scheduling

```bash
kelly remind "check quotation queue" in 2h
kelly reminder list
kelly schedule status
```

## Project Structure

```
kelly/
├── src/
│   ├── cli.ts              # Command-line interface
│   ├── runtime.ts          # Kelly runtime (service composition)
│   ├── config.ts           # Configuration (KELLY_* prefixed)
│   ├── profile.ts          # Profile system (henry/kelly)
│   ├── agent/              # LLM orchestration
│   ├── memory/             # Memory system (Engram)
│   ├── approval/           # Approval workflows
│   ├── reminders/          # Reminders and scheduling
│   ├── telegram/           # Telegram integration
│   ├── dashboard/          # Web dashboard
│   └── ...
├── bin/
│   ├── henry.mjs           # Henry launcher
│   └── kelly.mjs           # Kelly launcher (sets profile)
├── data/
│   ├── kelly.db            # Memory database
│   ├── activity.jsonl      # Activity log
│   ├── approvals.json      # Pending approvals
│   └── ...
└── soul.md                 # Kelly's personality (ignored by git)
```

## Architecture

Kelly shares Henry's core runtime with profile-based service composition:

- **Profile**: Defines which services are loaded (Kelly excludes certain integrations)
- **Isolated paths**: Separate `data/kelly/` and `memory/kelly/` directories
- **Configuration**: `KELLY_` environment variable prefix
- **Launcher**: `bin/kelly.mjs` sets the profile before CLI initialization

This design allows multiple profiles to coexist on the same codebase while maintaining separate data.

## Rates and Pricing

Use rupees (₹) in Kelly's quotations and discussions:

```
₹ = Indian Rupee (default currency)
```

Use Indian rupees for every price and quotation.

## Support

For issues or questions:
- Check `.env.example` for configuration options
- Review `CLAUDE.md` for Henry's documentation (Kelly shares most architecture)
- Run `kelly :help` in the REPL for available commands
- Check `data/kelly/activity.jsonl` for detailed logs

## License

MIT
