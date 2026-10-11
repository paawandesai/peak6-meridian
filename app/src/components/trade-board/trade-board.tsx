"use client";

import { useCallback, useEffect, useRef } from "react";

import { LandingHeader } from "../markets/landing-header";
import { MarketsEmpty, MarketsLoading } from "../markets/markets-states";
import { PageNotes } from "../markets/notes";
import { useMarketSources } from "../markets/data-context";
import { useReader } from "../reader-context";
import { useTestMarkets } from "../test-market-context";
import { useAsync } from "../use-async";
import { useNow } from "../use-now";
import { TestMarketToggle } from "../ui";
import { DetailView } from "./detail-view";
import { tileButtonId } from "./stock-tile";
import { TileGrid } from "./tile-grid";
import { BOARD_TICKERS, type BoardTicker, type StrikeCell, type TileModel } from "./types";
import { useBoardSelection } from "./use-board-selection";
import { tradeHref } from "@/app/trade/_lib/href";
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

/** The tile the detail view shows: the one whose open strikes hold `market`, else the session tile. */
export function detailTile(
  ticker: BoardTicker | null,
  market: string | null,
  boards: readonly (readonly TileModel[])[],
): TileModel | undefined {
  if (ticker === null) return undefined;
  const candidates = boards.flatMap((tiles) => tiles.filter((tile) => tile.ticker === ticker));
  return (
    candidates.find((tile) => tile.open.some((cell) => cell.market.address === market)) ??
    candidates[0]
  );
}

/**
 * Moves focus back to the tile's header button once the detail view has closed (spec §2.3). Runs
 * after the render that removed the detail, so the button is in the document.
 */
function useReturnFocus(selected: BoardTicker | null): (ticker: BoardTicker) => void {
  const pending = useRef<BoardTicker | null>(null);
  useEffect(() => {
    const ticker = pending.current;
    if (selected !== null || ticker === null) return;
    pending.current = null;
    document.getElementById(tileButtonId(ticker))?.focus();
  }, [selected]);
  return useCallback((ticker: BoardTicker) => {
    pending.current = ticker;
  }, []);
}

/**
 * The one-page Trade board on `/` (docs/redesign-spec.md): all seven stocks as tiles, and the
 * selected one in a detail view above the grid. The only component on the board that calls data
 * hooks; it makes the reads `MarketsView` made, once for the page (spec §3), and hands the tiles
 * and the detail plain props. The selection lives in the URL (`?t=` / `?m=`).
 */
export function TradeBoard({ nowSecs }: { readonly nowSecs?: number }) {
  const reader = useReader();
  const ticking = useNow();
  const { showTestMarkets, setShowTestMarkets } = useTestMarkets();
  const clock = nowSecs ?? ticking;
  const state = useAsync(() => reader.listMarkets(), [reader]);
  const config = useAsync(() => reader.getConfig(), [reader]);
  const sources = useMarketSources();
  const all = state.status === "ready" ? state.value : [];
  const { session, test } = partitionMarkets(all);
  const data = useMarketData([...session, ...test], sources.data ?? NO_SOURCES);
  const pythQuotes = usePythQuotes();
  const fairValues = useFairValues();
  const { selection, selectTicker, selectMarket, clear } = useBoardSelection();
  const returnFocusTo = useReturnFocus(selection.ticker);

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

  const cfg =
    config.status === "ready" ? config.value : { paused: false, overrideDelaySecs: 3_600n };
  const ctx = { nowSecs: clock, paused: cfg.paused, overrideDelaySecs: cfg.overrideDelaySecs };
  const inputs: TileInputs = {
    nowSecs: clock,
    books: data.books,
    fairByMarket: fairValues.byMarket,
    pythQuotes: pythQuotes.quotes,
  };
  const tiles = buildTiles(session, inputs, true);
  const testTiles = showTestMarkets ? buildTiles(test, inputs, false) : [];
  const detail = detailTile(selection.ticker, selection.market, [tiles, testTiles]);
  const fairMeta = { status: fairValues.status, lastSuccessSecs: fairValues.lastSuccessSecs };
  // Only when trading has stopped everywhere: an open market alongside a closed one keeps it hidden.
  const statuses = session.map((m) => marketStatus(m, clock));
  const needsSettleNote =
    !statuses.some((s) => s === "Open" || s === "ClosingSoon") &&
    statuses.some((s) => s === "Closed" || s === "Settling" || s === "SettlementDelayed");
  const hasNoMarkets = session.length === 0 && (!showTestMarkets || test.length === 0);

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
      {detail === undefined ? null : (
        <DetailView
          tile={detail}
          selectedMarket={selection.market}
          fair={fairValues}
          ctx={ctx}
          onSelectMarket={(market) => selectMarket(detail.ticker, market)}
          onClose={() => {
            returnFocusTo(detail.ticker);
            clear();
          }}
          tradeHref={tradeHref}
        />
      )}
      {hasNoMarkets ? (
        <MarketsEmpty />
      ) : (
        <TileGrid
          tiles={tiles}
          selectedTicker={detail !== undefined && tiles.includes(detail) ? detail.ticker : null}
          fairMeta={fairMeta}
          ctx={ctx}
          onSelectTicker={selectTicker}
          onSelectMarket={selectMarket}
        />
      )}
      {testTiles.length > 0 ? (
        <section aria-labelledby="test-markets-heading" className="space-y-mer-4">
          <h3 id="test-markets-heading" className="text-mer-lg font-semibold">
            Test Markets
          </h3>
          <TileGrid
            tiles={testTiles}
            selectedTicker={
              detail !== undefined && testTiles.includes(detail) ? detail.ticker : null
            }
            fairMeta={fairMeta}
            ctx={ctx}
            onSelectTicker={(ticker) => {
              const first = testTiles.find((tile) => tile.ticker === ticker)?.open[0];
              if (first === undefined) selectTicker(ticker);
              else selectMarket(ticker, first.market.address);
            }}
            onSelectMarket={selectMarket}
          />
        </section>
      ) : null}
    </div>
  );
}
