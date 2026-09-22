# Module: trade packs

**You are Claude Code, Codex, or another coding agent, reading this inside
Kelly's repo.** Already implemented at `src/trade/index.ts`,
`src/trade/electrical.ts`, and `src/trade/boutique.ts` — don't rebuild it.
Configure and verify only.

## 1. What it does

A trade pack is a fixed-per-install configuration that shapes Kelly's system
prompt, quotation intake fields, and gallery taxonomy for one line of
business. The trade is chosen once at setup and does not switch at runtime;
switching it means reconfiguring the install, not flipping a runtime toggle.

`TradePack` (`src/trade/index.ts`):

```ts
interface TradePack {
  id: TradeId; // "electrical" | "boutique"
  displayName: string;
  defaultShopName: string;
  lineNoun: string;        // "product" | "service"
  catalogueNoun: string;   // "catalogue" | "rate card"
  brandRequired: boolean;
  accent: { copper: string; copper2: string; dim: string };
  promptBlock: string;
  quoteIntake: string[];       // fields Kelly must know before pricing
  galleryCategories: string[];
  galleryTags: string[];
  setupQuestions: string[];
}
```

`tradePack(id)` returns the pack for an id. `parseTradeId(value)` normalizes
an env value, defaults to `"electrical"` when unset or empty, and throws a
clear error listing valid ids for any other unknown value.

## 2. The two packs

- **electrical** — today's behaviour, unchanged: multi-brand product
  quotations, no gallery (empty categories/tags), brand required.
- **boutique** — "She Fashion House", a ladies' boutique: stitching
  quotations (suits/salwar kameez, blouses, lehengas, sarees fall and pico,
  kurtis, gowns, dupattas) and a customer-facing design gallery. The
  quotation and gallery features themselves ship in later phases (see
  `context.md`, "Boutique mode"); Phase A only wires the pack, prompt, config,
  and dashboard branding.

## 3. Configure

Two env keys, both read through `env()` (the `KELLY_`-prefixed helper in
`src/config.ts`):

```
KELLY_TRADE=electrical        # electrical | boutique, fixed per install, chosen at setup
KELLY_SHOP_NAME=               # optional; defaults to the trade pack's defaultShopName
```

`loadConfig()` exposes `config.trade` (`TradeId`) and `config.shopName`
(`string`). `HenryRuntime.trade` is a getter that resolves
`tradePack(config.trade)` for callers (the dashboard, the agent prompt) that
need the whole pack, not just the id.

## 4. Where it shows up

- `src/agent/henry.ts` — `kellyStaticBlocks` includes a `TRADE: <displayName>.
  SHOP: <shopName>.` line and the pack's `promptBlock`, replacing the two
  electrical-specific sentences that used to be hardcoded there. The
  language rule (Hindi/English/Hinglish handling) is trade-independent and
  stays as-is.
- `src/dashboard/server.ts` — the voice-mode instruction block interpolates
  `runtime.trade.catalogueNoun` ("catalogue" vs "rate card") and answers in
  clear English regardless of the speaker's language mix.
- `/api/status` — includes `trade: { id, displayName, shopName, accent }`.
- `src/dashboard/page.ts` — the switchboard brand text and mark letter follow
  the shop name; a plain "Counter" tab links to `/voice`.
- `src/dashboard/voice.html` — served through `voiceHtml(shopName, accent)`
  in `src/dashboard/server.ts`, which does a string replace of
  `<!--KELLY_SHOP-->`, `<!--KELLY_MARK-->`, and `<!--KELLY_ACCENT-->` on a
  cached read of the raw file. The page title becomes `<shopName> ·
  counter`.

## 5. Add a pack

1. Add the id to `TradeId` in `src/trade/index.ts`.
2. Add a `src/trade/<id>.ts` exporting a `TradePack` (mirror
   `electrical.ts` or `boutique.ts`).
3. Register it in the `PACKS` map in `src/trade/index.ts`.
4. Extend `parseTradeId`'s error message coverage (automatic, since it lists
   `Object.keys(PACKS)`).
5. Add tests mirroring `tests/kelly-trade.test.ts`.

## 6. Demo commands

```bash
node bin/kelly.mjs start --demo                       # electrical demo, data/demo/
node bin/kelly.mjs start --demo --trade boutique       # boutique demo, data/demo-boutique/
node bin/kelly.mjs start --demo --trade electrical
```

`--trade` is only valid together with `--demo`; the boutique demo sets
`KELLY_SHOP_NAME=She Fashion House` and creates
`data/demo-boutique/{data,memory,knowledge}` if missing. Both demo roots are
already covered by the repo's `/data/` gitignore rule.

## 7. Boutique rate cards and quoting

The boutique pack (`brandRequired: false`) prices stitching jobs from an
imported rate card rather than a multi-brand product catalogue; see
`docs/modules/boutique.md` for the rate-card template, quoting without a
brand, and how a chat or voice turn's spoken reply gets its price.

## 8. Design gallery

`galleryCategories` and `galleryTags` on a pack are also the validation lists
for the customer-facing design gallery: `DesignStore.add` (and `update`)
reject a category or tag that is not in the active pack's lists. Electrical's
pack keeps both lists empty, so `runtime.designs` still exists but nothing
can ever be added to it and the Designs pane stays hidden. See
`docs/modules/designs.md` for the store, CLI, routes, and the fenced
`designs` block contract Kelly's replies use to show a gallery.
