"use client";

import { useState } from "react";

import { LandingHeader } from "../markets/landing-header";
import { MarketsEmpty, MarketsLoading } from "../markets/markets-states";
import { PageNotes } from "../markets/notes";
import { useMarketSources } from "../markets/data-context";
import { useReader } from "../reader-context";
import { useTestMarkets } from "../test-market-context";
import { useAsync } from "../use-async";
import { useNow } from "../use-now";
import { TestMarketToggle } from "../ui";
import { BOARD_TICKERS, type BoardTicker, type StrikeCell, type TileModel } from "./types";
import type { FairValue } from "@/lib/fair-values";
import { useFairValues } from "@/lib/fair-values";
import { useMarketData, type MarketBook, type MarketDataSources } from "@/lib/market-data";
import { marketStatus, partitionMarkets, type MarketRow } from "@/lib/markets";
import type { PythQuote } from "@/lib/pyth-quotes";
import { usePythQuotes } from "@/lib/use-pyth-quotes";

/** Inert sources for pages without a data provider: nothing is live, so rows show "—". */
const NO_SOURCES: MarketDataSources = {
  fetchPrices: () => Promise.reject(new Error("no price source")),
  fetchBooks: () => Promise.resolve({}),
};

const isBoardTicker = (ticker: string): ticker is BoardTicker =>
  (BOARD_TICKERS as readonly string[]).includes(ticker);

const byStrike = (a: StrikeCell, b: StrikeCell): number =>
  a.market.strikeCents < b.market.strikeCents
    ? -1
    : a.market.strikeCents > b.market.strikeCents
      ? 1
      : 0;

export type TileInputs = {
  readonly nowSecs: number;
  readonly books: Readonly<Record<string, MarketBook>>;
  readonly fairByMarket: Readonly<Record<string, FairValue>>;
  readonly pythQuotes: Readonly<Partial<Record<BoardTicker, PythQuote>>>;
};

/**
 * One tile per board ticker in {@link BOARD_TICKERS} order (spec §2.1). Open means Open or
 * ClosingSoon; everything else is closed. Both lists ascend by strike. With `keepEmpty` a ticker
 * with no markets still gets a tile (the session board); without it only tickers that have
 * markets do (the test-market board). Markets for tickers outside the board are dropped.
 */
export function buildTiles(
  markets: readonly MarketRow[],
  inputs: TileInputs,
  keepEmpty: boolean,
): TileModel[] {
  const cells = new Map<BoardTicker, { open: StrikeCell[]; closed: StrikeCell[] }>();
  for (const market of markets) {
    if (!isBoardTicker(market.ticker)) continue;
    const book = inputs.books[market.address];
    const cell: StrikeCell = {
      market,
      quotes: book?.state === "ready" ? book.quotes : null,
      fair: inputs.fairByMarket[market.address],
    };
    const lists = cells.get(market.ticker) ?? { open: [], closed: [] };
    const status = marketStatus(market, inputs.nowSecs);
    (status === "Open" || status === "ClosingSoon" ? lists.open : lists.closed).push(cell);
    cells.set(market.ticker, lists);
  }
  return BOARD_TICKERS.filter((ticker) => keepEmpty || cells.has(ticker)).map((ticker) => {
    const lists = cells.get(ticker);
    return {
      ticker,
      open: [...(lists?.open ?? [])].sort(byStrike),
      closed: [...(lists?.closed ?? [])].sort(byStrike),
      pythQuote: inputs.pythQuotes[ticker],
    };
  });
}

/**
 * Placeholder tile grid until `TileGrid` (feat/rd-tiles) lands: the grid layout and one
 * `section` per tile with the symbol-only `h2` and the button that selects it.
 */
function GridPlaceholder({
  tiles,
  selected,
  onSelect,
}: {
  readonly tiles: readonly TileModel[];
  readonly selected: BoardTicker | null;
  readonly onSelect: (ticker: BoardTicker) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-mer-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {tiles.map((tile) => (
        <section
          key={tile.ticker}
          aria-label={tile.ticker}
          {...(selected === tile.ticker ? { "aria-current": "true" as const } : {})}
          className="rounded-mer-md border border-mer-rule p-mer-3"
        >
          <button type="button" onClick={() => onSelect(tile.ticker)}>
            <h2 className="text-mer-lg font-semibold">{tile.ticker}</h2>
          </button>
          <p className="text-mer-sm text-mer-ink-muted">
            {tile.open.length + tile.closed.length === 0
              ? `No markets today for ${tile.ticker}`
              : `${tile.open.length} open · ${tile.closed.length} closed`}
          </p>
        </section>
      ))}
    </div>
  );
}

/** Placeholder detail view until `DetailView` (feat/rd-detail) lands. */
function DetailPlaceholder({
  tile,
  onClose,
}: {
  readonly tile: TileModel;
  readonly onClose: () => void;
}) {
  return (
    <section aria-label={`${tile.ticker} detail`} className="rounded-mer-md border p-mer-4">
      <h2 className="text-mer-lg font-semibold">{tile.ticker}</h2>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </section>
  );
}

/**
 * The one-page Trade board on `/` (docs/redesign-spec.md): all seven stocks as tiles, with a
 * detail view above the grid for the selected one. The only component on the board that calls
 * data hooks; it makes the same reads `MarketsView` makes, once for the page (spec §3). Placeholder
 * stage: config and open times (for each tile's `BadgeContext`) are read when the tiles are wired.
 */
export function TradeBoard({ nowSecs }: { readonly nowSecs?: number }) {
  const reader = useReader();
  const ticking = useNow();
  const { showTestMarkets, setShowTestMarkets } = useTestMarkets();
  const clock = nowSecs ?? ticking;
  const state = useAsync(() => reader.listMarkets(), [reader]);
  const sources = useMarketSources();
  const all = state.status === "ready" ? state.value : [];
  const { session, test } = partitionMarkets(all);
  const data = useMarketData([...session, ...test], sources.data ?? NO_SOURCES);
  const pythQuotes = usePythQuotes();
  const fairValues = useFairValues();
  // Replaced by `useBoardSelection` (`?t=` / `?m=`) in the lead's wiring step.
  const [selected, setSelected] = useState<BoardTicker | null>(null);

  if (state.status === "loading" || clock === null) {
    return (
      <div className="space-y-mer-6">
        <LandingHeader />
        <MarketsLoading />
      </div>
    );
  }
  if (state.status === "error") {
    return <p role="alert">Could not load markets: {state.message}</p>;
  }

  const inputs: TileInputs = {
    nowSecs: clock,
    books: data.books,
    fairByMarket: fairValues.byMarket,
    pythQuotes: pythQuotes.quotes,
  };
  const tiles = buildTiles(session, inputs, true);
  const testTiles = buildTiles(test, inputs, false);
  // Only when trading has stopped everywhere: an open market alongside a closed one keeps it hidden.
  const statuses = session.map((m) => marketStatus(m, clock));
  const needsSettleNote =
    !statuses.some((s) => s === "Open" || s === "ClosingSoon") &&
    statuses.some((s) => s === "Closed" || s === "Settling" || s === "SettlementDelayed");
  const hasNoMarkets = session.length === 0 && (!showTestMarkets || test.length === 0);
  const selectedTile = tiles.find((tile) => tile.ticker === selected);

  return (
    <div className="space-y-mer-6">
      <LandingHeader />
      <PageNotes showSettleNote={needsSettleNote} />
      {test.length > 0 ? (
        <TestMarketToggle
          testMarketCount={test.length}
          showTestMarkets={showTestMarkets}
          onToggle={() => setShowTestMarkets(!showTestMarkets)}
        />
      ) : null}
      {selectedTile === undefined ? null : (
        <DetailPlaceholder tile={selectedTile} onClose={() => setSelected(null)} />
      )}
      {hasNoMarkets ? (
        <MarketsEmpty />
      ) : (
        <GridPlaceholder tiles={tiles} selected={selected} onSelect={setSelected} />
      )}
      {showTestMarkets && testTiles.length > 0 ? (
        <div className="space-y-mer-4">
          <h3 className="text-mer-lg font-semibold">Test Markets</h3>
          <GridPlaceholder tiles={testTiles} selected={null} onSelect={() => undefined} />
        </div>
      ) : null}
    </div>
  );
}
