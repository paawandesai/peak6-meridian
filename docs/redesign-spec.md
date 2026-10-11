# Trade redesign: one-page board (spec)

Branch: `feat/trade-redesign` (integration). Workers branch from it: `feat/rd-tiles`, `feat/rd-detail`.
Read with: [design.md](design.md) §3 (displayed-price rule, fair value and edge, staleness), §6 (layout and accessibility floor); [domain.md § Units](domain.md#units-integers-only-never-floats-on-chain).

## 1. Goal

Replace the per-ticker ladder stack on `/` (`MarketsView`) with one page that shows all seven stocks at once, so you can scan for edge in one place and then drill into a single stock without changing page.

```
┌ AppHeader (unchanged) ──────────────────────────────────────────────────────────────────┐
│ LandingHeader · PageNotes (unchanged)                                                   │
├ Detail (only when a stock is selected) ─────────────────────────────────────── [Close] ┤
│ NVDA  $181.42 as of 14:52:05 ET · closes 16:00 ET                                        │
│ Strike [$170][$175][$180*][$185][$190]   Fair 58¢ · Edge +4¢ (rich)  [Trade this strike]│
│ ┌ Implied distribution (market vs fair) ┐ ┌ Price (1D | 1W), strike lines ───────────┐  │
│ └───────────────────────────────────────┘ └───────────────────────────────────────────┘  │
├ Board ──────────────────────────────────────────────────────────────────────────────────┤
│ ┌ AAPL $227.10 ──┐ ┌ AMZN ─────────┐ ┌ GOOGL ────────┐ ┌ META ─────────┐                  │
│ │ Strike YES Fair Edge            │ │ ...           │ │ ...           │                  │
│ │ $220   81¢  79¢ Edge +2¢ (rich) │ │               │ │               │                  │
│ │ ── live $227.10 ──              │ │               │ │               │                  │
│ │ $230   38¢  41¢ Edge −3¢ (cheap)│ │               │ │               │                  │
│ │ +4 more strikes                 │ │               │ │               │                  │
│ └─────────────────┘ └───────────────┘ └───────────────┘ └───────────────┘                  │
│ ┌ MSFT ──────────┐ ┌ NVDA (selected)┐ ┌ TSLA ────────┐                                    │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

Out of scope: order entry. The order panel, book and signing flow stay on `/trade/[market]` unchanged; the detail view links there. Replay (`?replay=`) keeps rendering `ReplayView` unchanged. No program, client, service or API-route change. No new dependency (`lightweight-charts` 4.2.2 and `recharts` 2.15.4 are already in `app/package.json`).

## 2. Behaviour

### 2.1 Board (grid of 7 tiles)
- Exactly seven tiles in fixed order: AAPL, AMZN, GOOGL, META, MSFT, NVDA, TSLA. A ticker with no markets still gets a tile that says "No markets today for {ticker}".
- Grid columns: 1 at 390 px, 2 at `md` (768), 3 at `lg` (1024), 4 at `xl` (1280). No horizontal scroll at 390 px.
- Session markets only by default; test markets follow the existing `TestMarketToggle` (shown in a separate "Test markets" board below, never mixed into a session tile, as today).
- Each tile is a `section` with `aria-label={ticker}` and an `h2` holding only the symbol (the M1-12 / UI-03 heading rule). Sibling header items: live Pyth price via the existing `PythPrice` / `PythPricePlaceholder`, and `closes {HH:MM} ET` for the primary close set.
- Selecting a tile (its header button) opens the detail view for that ticker; the tile gets `aria-current="true"` and a visible selected style.

### 2.2 Compact strike ladder (inside each tile)
- Strikes come from the tile's open markets via the existing `closeSets(open, live).primary` (exported from `components/markets/ticker-ladder.tsx`; import it, do not copy it).
- Show at most 5 strikes: the window of 5 centred on the live price (the strike at or below live and the ones around it), clamped to the ends. The rest are a "+N more strikes" button that opens the detail view.
- Columns: **Strike · YES · Fair · Edge**. A semantic `table` with one header row and one row per strike.
  - **YES** follows the displayed-price rule (design.md §3) through `yesView`: mid `58¢`; range `55–70¢ wide`; none `—` with `aria-label="price not live yet"`. Same rendering as `StrikeRow`'s `YesCell`.
  - **Fair** `{fair_cents}¢`, muted with the existing `StaleTag` when `staleReasons(...)` is non-empty; `—` (sr text "no fair value") when the service has none; "…" (`role="status"`) while loading.
  - **Edge** the existing `EdgeLabel` (`Edge +4¢ (rich)`; word always written). Only when YES is a mid and fair exists; otherwise `—`. Muted when fair is stale.
- The live-price marker is a decorative `aria-hidden` line between the two strikes it falls between, never a table row (design.md §5 Markets (f)).
- Selecting a strike row opens the detail view with that market selected.
- No open markets: show the state in words ("Closed · settling", "Markets closed"), from `marketStatus`, with no ladder table.
- "No quotes yet: odds appear when the market maker posts." when no strike of the tile has a quote (same copy as today).
- Do **not** reuse `CompactStrikeRow`: its edge chip carries meaning in colour only and has no rich/cheap word.

### 2.3 Detail view
- Rendered above the board, full width, only while a ticker is selected. Opening it moves focus to its `h2`; **Close** (button, and `Esc`) clears the selection and returns focus to the tile's header button.
- Header: ticker `h2`, `PythPrice`, close time.
- Strike selector: a radio group (one option per strike of the primary close set), defaulting to the strike at or just above the live price when no `m` is given. The selected strike shows the existing `FairEdge` and a **Trade this strike** link to `tradeHref(market)`.
- **Distribution chart:** the existing `DistributionChart`, fed by `distributionPoints(ladder, quotes, fairByAddress, fairStaleness(...))` exactly as `TickerInsightView` builds it; when no strike is priced, show `emptyDistributionText(ticker)`. Always open in the detail view (no disclosure).
- **Price line chart:** new `PriceLineChart` (§4.2) for the ticker, with a horizontal line per strike of the primary set (selected strike emphasised and labelled). It never draws fair value: fair value is a YES probability in cents, not a share price.
- 390 px: distribution and price charts stack; at `lg` and up they sit side by side.

### 2.4 URL state
- `?t={TICKER}` selects a ticker; `?t={TICKER}&m={market address}` also selects a strike. Unknown values are ignored (no selection). `router.replace` with `scroll: false`, as `useTickerSelection` does. Back/forward restore the selection.
- `t` keeps today's meaning (a ticker deep link) so existing `?t=` links still land on that stock.

## 3. Data flow (one owner, no new reads)

`TradeBoard` (lead-owned) is the only component that calls data hooks. It makes the same reads `MarketsView` makes today, once for the whole page: `reader.listMarkets()`, `reader.getConfig()`, `useMarketData(allMarkets, sources)`, `usePythQuotes()`, `useFairValues()`, `useOpenTimes()`, `useNow()`. Tiles and detail are pure presentational components that receive props. The only fetch outside `TradeBoard` is `PriceLineChart`'s call to `/api/pyth-history`, at most one per ticker per 5-minute bucket, and only while the detail view is open. The RPC budget (`lib/rpc-budget.test.tsx`) must not grow.

## 4. Contracts

### 4.1 `app/src/components/trade-board/types.ts` (lead-owned; lands before workers start)

```ts
import type { BookQuotes } from "@meridian/client";
import type { FairValue, FairValues } from "@/lib/fair-values";
import type { BadgeContext } from "@/lib/market-view";
import type { MarketRow } from "@/lib/markets";
import type { PythQuote } from "@/lib/pyth-quotes";

export const BOARD_TICKERS = ["AAPL", "AMZN", "GOOGL", "META", "MSFT", "NVDA", "TSLA"] as const;
export type BoardTicker = (typeof BOARD_TICKERS)[number];

/** Everything the board knows about one strike. */
export type StrikeCell = {
  readonly market: MarketRow;
  readonly quotes: BookQuotes | null;
  readonly fair: FairValue | undefined;
};

/** One tile's input. `open`/`closed` ascending by strike. */
export type TileModel = {
  readonly ticker: BoardTicker;
  readonly open: readonly StrikeCell[];
  readonly closed: readonly StrikeCell[];
  readonly pythQuote: PythQuote | undefined;
};

export type FairMeta = Pick<FairValues, "status" | "lastSuccessSecs">;

export type StockTileProps = {
  readonly tile: TileModel;
  readonly fairMeta: FairMeta;
  readonly ctx: BadgeContext;
  readonly selected: boolean;
  readonly onSelectTicker: (ticker: BoardTicker) => void;
  readonly onSelectMarket: (ticker: BoardTicker, market: string) => void;
};

export type TileGridProps = Omit<StockTileProps, "tile" | "selected"> & {
  readonly tiles: readonly TileModel[];
  readonly selectedTicker: BoardTicker | null;
};

export type DetailViewProps = {
  readonly tile: TileModel;
  /** Address of the selected strike, or `null` for the default (§2.3). */
  readonly selectedMarket: string | null;
  readonly fair: FairValues;
  readonly ctx: BadgeContext;
  readonly onSelectMarket: (market: string) => void;
  readonly onClose: () => void;
  readonly tradeHref: (market: Pick<MarketRow, "address">) => string;
};
```

A worker that needs a contract change asks the lead; nobody else edits this file.

### 4.2 `PriceLineChart` (detail worker)
- Props: `{ ticker: BoardTicker; nowSecs: number; strikes: readonly bigint[]; selectedStrikeCents: bigint | null }`.
- Ranges: **1D** (`resolution=5`, `from = to − 86_400`) default, **1W** (`resolution=60`, `from = to − 604_800`); `to` is `nowSecs` floored to 300 s so the route's 60 s cache hits. Symbol `Equity.US.{ticker}/USD`. Toggle is a two-button group with `aria-pressed`.
- Parse the response with `zod` (same shape as the route's `PythHistorySchema`; `t` and `c` same length, else treat as no data). Convert closes to integer cents at the boundary (`Math.round(c * 100)`); the chart receives `cents / 100` for display only, nothing else does arithmetic on it.
- `lightweight-charts` line series, colours from CSS tokens (`--mer-ink`, `--mer-rule`, `--mer-paper`, `--mer-primary`), created once per mount, removed on unmount, resized with the container. Strike lines via `createPriceLine` (dashed; selected solid with `$180` title).
- Refetch when the 5-minute bucket or range changes; keep the last good series on a failed refetch. States in words: "Loading price history…", "No price history from Pyth right now." (`s:"no_data"` or empty), "Price history unavailable." (HTTP/parse error). `fetch` with `AbortSignal.timeout(6_000)`; abort on unmount.
- Accessible name: `figure` with `figcaption` "{ticker} price, last day" / "last week" and the latest close as text ("$181.42 at 14:50 ET", ET via `lib/time`).

## 5. File ownership

Workers create and edit **only** the files listed for them, plus their own tests next to them. Anything not listed belongs to the lead.

| Owner | Files |
|---|---|
| **Tiles + ladder worker** (`feat/rd-tiles`) | `app/src/components/trade-board/tile-grid.tsx` · `app/src/components/trade-board/stock-tile.tsx` · `app/src/components/trade-board/tile-ladder.tsx` · `app/src/components/trade-board/tile-window.ts` (pure: the 5-strike window and live-marker index) · tests: `tile-grid.test.tsx`, `stock-tile.test.tsx`, `tile-ladder.test.tsx`, `tile-window.test.ts` (fast-check property tests for the window) |
| **Detail worker** (`feat/rd-detail`) | `app/src/components/trade-board/detail-view.tsx` · `app/src/components/trade-board/strike-selector.tsx` · `app/src/components/trade-board/default-strike.ts` (pure: default strike from live price) · `app/src/components/price-line-chart/price-line-chart.tsx` · `app/src/components/price-line-chart/history.ts` (query building, zod parse, cents conversion) · tests: `detail-view.test.tsx`, `strike-selector.test.tsx`, `default-strike.test.ts`, `price-line-chart.test.tsx`, `history.test.ts` (fast-check for parse and cents conversion) |
| **Lead only (shared)** | `app/src/components/trade-board/types.ts` · `app/src/components/trade-board/trade-board.tsx` (data hooks, tile models, layout, test-market board) · `app/src/components/trade-board/use-board-selection.ts` (`?t=` / `?m=`) and their tests · `app/src/components/markets-page.tsx` (swap `MarketsView` for `TradeBoard`) · `app/src/app/page.tsx` · `app/src/components/app-header.tsx` · `app/src/app/globals.css` (Tailwind tokens) · `app/package.json`, lockfile · existing tests that change because `/` changes (`markets-page.test.tsx`, `app/page.test.tsx`, `lib/rpc-budget.test.tsx`, `tests/e2e/playwright/02-markets.spec.ts`, `tests/e2e/p0-2-smoke-standalone.spec.ts`, `tests/e2e/playwright/p0-2-price-chart-smoke.spec.ts`) · `docs/` |

**Reused read-only** (import, never edit; a needed change goes to the lead): `components/fair-value/fair-edge.tsx` (`FairEdge`, `EdgeLabel`, `StaleTag`, `fairDetail`) · `components/distribution-chart/*` (`DistributionChart`, `distributionPoints`, `displayedYes`, `fairStaleness`, `emptyDistributionText`) · `components/markets/ticker-ladder.tsx` (`closeSets`, `soonestOpenClose`) · `components/markets/strike-row.tsx` · `components/pyth-price.tsx` · `components/ui/*` · `lib/*` (`fair-values`, `market-view`, `markets`, `time`, `pyth-quotes`) · `app/trade/_lib/href.ts` · `app/api/pyth-history/route.ts`.

`MarketsView`, `TickerLadder`, `TickerTabs`, `PriceHistoryChart` and `TickerInsight` stay in the tree untouched (the Trade page still mounts `PriceHistoryChart`); removing the unused ones is a later lead-owned cleanup, not part of either worker's ticket.

## 6. Order of work

1. Lead: `types.ts`, a `trade-board.tsx` that renders placeholders for grid and detail, `use-board-selection.ts`, and this spec, on `feat/trade-redesign`. Workers rebase on it.
2. Workers in parallel on their branches. Each MR targets `feat/trade-redesign`.
3. Lead: wire `TileGrid` and `DetailView` into `TradeBoard`, switch `markets-page.tsx`, update the shared tests, run the full gate, MR `feat/trade-redesign` → `main`.

## 7. Acceptance criteria and evidence

| # | Criterion | Owner | Evidence |
|---|---|---|---|
| AC1 | Seven tiles in fixed order, including tickers with no markets | tiles | `tile-grid.test.tsx` |
| AC2 | Ladder shows ≤ 5 strikes centred on live, "+N more" opens detail | tiles | `tile-window.test.ts` (property), `tile-ladder.test.tsx` |
| AC3 | YES follows the displayed-price rule (mid / range "wide" / "—") | tiles | `tile-ladder.test.tsx` |
| AC4 | Fair and edge: word always written; stale muted with tag and reason; "—" when missing; edge only with a mid | tiles | `tile-ladder.test.tsx` |
| AC5 | Live marker is `aria-hidden`, not a row; one header row; `h2` holds only the symbol | tiles | `tile-ladder.test.tsx`, `stock-tile.test.tsx` |
| AC6 | Detail: default strike, selector, `FairEdge`, Trade link to `/trade/{address}` | detail | `detail-view.test.tsx`, `default-strike.test.ts` |
| AC7 | Distribution chart from the ladder; empty text when nothing is priced | detail | `detail-view.test.tsx` |
| AC8 | Price line chart: 1D/1W query, zod parse, cents at the boundary, strike lines, no fair line, three text states, last good data kept | detail | `history.test.ts` (property), `price-line-chart.test.tsx` (mocked `fetch` and `lightweight-charts`) |
| AC9 | Focus moves to detail on open and back to the tile on Close/Esc | detail + lead | `detail-view.test.tsx`, `trade-board.test.tsx` |
| AC10 | `?t=` / `?m=` round-trip; unknown values ignored | lead | `use-board-selection.test.ts` |
| AC11 | No new reads: RPC budget unchanged; history only while detail is open | lead | `lib/rpc-budget.test.tsx` |
| AC12 | 390 px and 1280 px, no horizontal scroll; Lighthouse a11y ≥ 90 on `/` | lead | `make e2e-ui`, one-off `npx lighthouse` |
| AC13 | Gate green | all | `make lint typecheck test test-security coverage` (app ≥ 80 % lines) |

Tests mock every network call (`/api/pyth-history`, `/api/fair-values`, RPC); none call Pyth.

## 8. Decisions (for the MR's "Decisions" section)

- **Board on `/`, order entry stays on `/trade/[market]`.** Why: the order flow has its own evidence suite (M2-06/UI-04) and signing tests; moving it is a separate change. Alternative: embed `OrderPanel` in the detail view. Reverse: render `TradeView` inside `DetailView` behind the same `m` param.
- **New `PriceLineChart` rather than a mode on `PriceHistoryChart`.** Why: the existing chart is collapsed-by-default candles, used on the Trade page, and plots fair cents as dollars; changing it would touch the Trade page. Reverse: point `TickerInsight` at the line chart and delete the candle chart.
- **Detail above the grid, not a side panel.** Why: one layout for 390 px and 1280 px, and the grid keeps its columns. Reverse: a two-column `lg` layout in `trade-board.tsx` only.

## 9. Open questions

- Should the nav label "Markets" become "Trade" now that `/` is the board? (Lead-owned `app-header.tsx`; e2e selectors depend on it.)
- Should the board show the next-day close sets anywhere, or only in the detail view's "+N more"? This spec shows only the primary (at-the-money, latest trading day) set in tiles.
