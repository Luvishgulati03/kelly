# Kelly — Electrical Shop Quotation Assistant

Kelly is a local-first catalogue and quotation agent for electrical shops. It turns supplier files into reviewed product records, finds matching items, and creates brand-specific quotations with deterministic pricing.

## What Kelly Does

Kelly helps you generate, organize, and manage electrical shop quotations with:

- **Catalogue ingestion** from PDF, XLSX, and CSV files with a review gate before products become searchable
- **Quotation generation** from published catalogue prices, including discounts and GST
- **Brand comparison** for the same customer requirements without rebuilding every quotation by hand
- **Excel navigation and safe editing** through a local Codex MCP server that always writes a new copy
- **Separate catalogue RAG** for product evidence; Engram memory is reserved for durable preferences and corrections
- **Codex orchestration** with no alternate-model fallback
- **Engram memory** for operator preferences and durable shop context
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
cp KELLY.env.example .env
cp soul.example.md soul.md
cp personality.example.md personality.md
codex login
node bin/kelly.mjs repl
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
# Defaults are isolated under ~/.kelly; override only when needed.
KELLY_DATA_DIR=/absolute/path/to/kelly-data
KELLY_MEMORY_DIR=/absolute/path/to/kelly-memory
KELLY_HOST=127.0.0.1
KELLY_PORT=7338
KELLY_PROVIDER=codex
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
kelly ask "Find published Havells LED bulb options and prepare a quote for 100 units"
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

Kelly keeps the inherited approval queue for any future outbound integration. Approval and execution remain separate actions:

```bash
kelly approve list
kelly approve approve <approval-id>
kelly approve send <approval-id>
```

### Reminders and Scheduling

```bash
kelly remind "check quotation queue" --in 2h
kelly remind list
kelly schedule status
```

## Catalogue and quotation workflow

Importing never publishes products immediately. Review the detected records first, then explicitly publish the document.

```bash
kelly catalogue import ./supplier-price-list.xlsx --sheet Products
kelly catalogue review
kelly catalogue publish <document-id>
kelly catalogue search "20W LED batten" --brand Havells
```

Create a quote from a JSON request so quantities, discounts, GST, and source products remain reproducible:

```bash
kelly quote create --from ./quote-request.json
kelly quote show <quote-id>
kelly quote compare --from ./requirements.json --brands Havells,Philips
kelly quote export <quote-id> --out ./customer-quote.xlsx
```

Prices are stored as integer paise and totals are calculated in code, not guessed by a language model. Incomplete or ambiguous matches stay unresolved and cannot be exported as a final quotation.

## Excel MCP connector

The project-local `.codex/config.toml` registers `kelly-excel-mcp`. It exposes four bounded tools: inspect a workbook, read a range, search cells, and save explicit edits to a new XLSX copy. The source workbook is never overwritten. XLSX and CSV are supported; legacy XLS and macro-enabled XLSM files are rejected.

```bash
kelly sheets inspect ./catalogue.xlsx
kelly sheets read ./catalogue.xlsx --sheet Products --range A1:F20
kelly sheets search ./catalogue.xlsx --query "ceiling fan"
kelly sheets edit ./catalogue.xlsx --edits ./edits.json --out ./catalogue-v2.xlsx
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
│   ├── telegram/           # Telegram interface
│   ├── dashboard/          # Web dashboard
│   ├── commerce/           # Catalogue, pricing, quote, and workbook services
│   ├── mcp/                # Local Excel MCP server
│   └── ...
├── bin/
│   ├── kelly.mjs           # Kelly launcher
│   └── kelly-excel-mcp.mjs # Excel MCP launcher
├── .codex/config.toml      # Project-local MCP registration
└── soul.md                 # Kelly's personality (ignored by git)
```

## Architecture

### Conversation learning

Every successful owner question and Kelly answer is embedded in an owner-only conversation-QA RAG. Customer-facing callers must use a stable `customer:<id>` surface key; each key maps to a physically separate vector database so requirements and quotations cannot cross between customers. Similar answers are secondary context only. Approved catalogue records, active prices, compatibility evidence, tax rules and deterministic quote calculations remain authoritative.

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
- Check `KELLY.env.example` for configuration options
- Review this file and the command help before changing inherited runtime modules
- Run `kelly :help` in the REPL for available commands
- Check Kelly's configured data directory for local activity logs

## License

MIT
