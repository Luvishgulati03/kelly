# Kelly

Kelly is a locally running business agent for small teams in India.

It is designed for businesses where the owner still handles repetitive work by
hand: preparing quotations, answering the same customer questions, checking
catalogues, updating spreadsheets, and following up on routine tasks. Kelly turns
those workflows into reliable tools that can be adapted to each business.

Quotation is the first complete workflow. Voice is the next major interface.

## Why Kelly exists

Small businesses rarely need another generic chatbot. They need an agent that
understands their products, follows their pricing rules, works with the files they
already use, and keeps business data under their control.

Kelly runs locally, learns from approved business material, and separates facts
from generated language. It can search a catalogue conversationally, but totals,
discounts, taxes, and final quotation values are calculated in code.

Kelly serves two trades today, an electrical shop and a ladies' boutique, one
trade per install. The trade is chosen once at setup (`KELLY_TRADE`) and does
not switch at runtime; each deployment stays one shop, one line of business.

### Try the boutique demo

```bash
kelly start --demo --trade boutique
```

This seeds an isolated demo rate card and 14 placeholder design photos for "She
Fashion House," a fictional ladies' boutique, and never touches real owner
data. Open the dashboard it prints, then look at the switchboard, the Designs
pane, and the Counter page. Try asking:

- "show me trending sarees"
- "how much for two salwar suits with lining, my own fabric, needed by Friday"

## What works today

- Import supplier catalogues from PDF, XLSX, and CSV files
- Review extracted products before publishing them to search
- Find matching items across brands and product categories
- Create and compare quotations in Indian rupees
- Apply discounts and GST with deterministic calculations
- Export quotations to Excel
- Inspect, search, and safely edit spreadsheets through a local Excel connector
- Remember owner preferences and recurring corrections
- Learn from previous questions without mixing one customer's context with another
- Run through the terminal, local web dashboard, or Telegram
- Schedule reminders and routine checks

## Where Kelly can go next

Kelly is built around business workflows, not one industry. A deployment can be
adapted for:

- customer support grounded in company documents
- product discovery and guided selling
- order intake and follow-up
- service booking and status updates
- stock and catalogue questions
- voice input in English, Hindi, Hinglish, or a business-specific language mix,
  with Kelly's answers returned in clear English

These are extension paths, not claims about the current release. The present build
has the deepest support for catalogue search, quotations, spreadsheets, and local
business memory.

## Roadmap

Planned, not built:

- Web image search fallback when a boutique deployment's design gallery has no match
  for a requested category — owner-approved sources only, results shown labeled as
  external, never saved without the owner's explicit yes.
- Try-on image generation ("how would this design look on her") from a customer photo —
  needs explicit consent and local-only storage rules.
- CLIP image embeddings for search-by-photo, once a deployment's designs store exists.

## How quotation works

```mermaid
flowchart LR
    A[Supplier files] --> B[Import and review]
    B --> C[Approved catalogue]
    D[Customer requirement] --> E[Product matching]
    C --> E
    E --> F[Pricing and GST rules]
    F --> G[Reviewable quotation]
    G --> H[Excel export]
```

The language model helps understand requests and retrieve likely products. The
catalogue remains the source of truth. Ambiguous matches stay unresolved until a
person reviews them.

## Quick start

Requires Node 22 or newer and an authenticated Codex CLI.

```bash
npm install
cp KELLY.env.example .env
cp soul.example.md soul.md
cp personality.example.md personality.md
codex login
node bin/kelly.mjs repl
```

The local dashboard runs at `http://127.0.0.1:7338` by default.

## Useful commands

```bash
kelly repl
kelly dashboard
kelly ask "Find ceiling fans under ₹3,000"

kelly catalogue import ./supplier-list.xlsx --sheet Products
kelly catalogue review
kelly catalogue publish <document-id>
kelly catalogue search "20W LED batten" --brand Havells

kelly quote create --from ./quote-request.json
kelly quote compare --from ./requirements.json --brands Havells,Philips
kelly quote export <quote-id> --out ./customer-quote.xlsx

kelly sheets inspect ./catalogue.xlsx
kelly sheets search ./catalogue.xlsx --query "ceiling fan"
kelly sheets edit ./catalogue.xlsx --edits ./edits.json --out ./catalogue-v2.xlsx
```

## Data and memory

Kelly keeps different kinds of knowledge separate:

| Layer | Purpose |
| --- | --- |
| Approved catalogue | Product facts, prices, brands, specifications, and source records |
| Business knowledge | Policies, FAQs, service details, and material supplied by the owner |
| Owner memory | Preferences, corrections, and durable operating decisions |
| Customer conversation memory | Previous questions and answers, isolated by customer |

Previous answers are hints, not authority. Current catalogue records, pricing
rules, and verified business documents always win.

## Safety and control

- Source catalogues are never overwritten.
- Spreadsheet edits are saved to a new file.
- Imported records require review before publication.
- Customer conversation stores are isolated.
- Outbound actions remain staged until the owner approves the exact action.
- The dashboard binds to the local machine unless secure remote access is
  explicitly configured.

## Product direction

Kelly's long-term interface is voice. A shop owner or staff member should be able
to ask for a quote, compare alternatives, answer a customer, or update a routine
record without learning a new back-office tool. The same workflow remains
available through web, Telegram, and terminal for review and control. The local
speech baseline under evaluation is quantized multilingual Whisper for
Hindi/English transcription and Kokoro-82M for English speech output; Hinglish shop-audio
quality has not yet been benchmarked. See [Voice](docs/voice.md) for model,
privacy, hardware, and setup notes.
The desktop's built-in Codex voice feature is not verified as an embeddable
Kelly interface; Kelly's documented voice path is its local CLI and dashboard.

## License

MIT. Copyright 2026 Luvish Gulati.
