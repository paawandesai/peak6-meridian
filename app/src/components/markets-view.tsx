"use client";

import { Landing, PageNotes } from "./markets/notes";
import { useMarketSources } from "./markets/data-context";
import { TickerLadder } from "./markets/ticker-ladder";
import type { StrikeData } from "./markets/strike-row";
import { useReader } from "./reader-context";
import { useAsync } from "./use-async";
import { useNow } from "./use-now";
import { useMarketData, type MarketDataSources } from "@/lib/market-data";
import { groupByTicker, marketStatus, type MarketRow } from "@/lib/markets";
import { tradeHref } from "@/app/trade/_lib/href";
import { usePythQuotes } from "@/lib/use-pyth-quotes";
import { useFairValues } from "@/lib/fair-values";

/** Inert sources for pages without a data provider: nothing is live, so rows show "—". */
const NO_SOURCES: MarketDataSources = {
  fetchPrices: () => Promise.reject(new Error("no price source")),
  fetchBooks: () => Promise.resolve({}),
};

// P0-4: removed useOpenTimes hook. Markets page shows "Opened —" (null openedAt).
// Only Trade page fetches the real creation time via reader.getOpenTime().

/**
 * Read-only list of on-chain markets as one strike ladder per ticker (FR-16, UI-03): all open
 * markets across all trading dates, YES / NO prices from the book, a state badge, the open and
 * close time in ET and a countdown to the next state change (D-050). Closed markets appear in a
 * collapsed section.
 */
export function MarketsView({
  nowSecs,
  tradeHref: tradeHrefProp,
}: {
  readonly nowSecs?: number;
  readonly tradeHref?: ((market: MarketRow) => string) | null;
}) {
  const reader = useReader();
  const ticking = useNow();
  // `null` until the clock has mounted (server render and first paint): the date-dependent parts
  // wait for it rather than treating a missing clock as the unix epoch.
  const clock = nowSecs ?? ticking;
  // Use the prop if provided (for tests): undefined → default imported tradeHref, null → no links.
  const tradeHrefFn =
    tradeHrefProp === undefined ? tradeHref : tradeHrefProp === null ? undefined : tradeHrefProp;
  const state = useAsync(() => reader.listMarkets(), [reader]);
  const config = useAsync(() => reader.getConfig(), [reader]);
  const sources = useMarketSources();
  const all = state.status === "ready" ? state.value : [];
  // Show ALL markets, not just active date — partition by open/closed status instead
  // Show ALL markets, partitioned by status within each ticker group
  const data = useMarketData(all, sources.data ?? NO_SOURCES);
  // M3-10: Fetch Pyth live quotes (D-055: Pyth Pro is primary demo price source)
  const pythQuotes = usePythQuotes();
  // M3-03: Fair values for edge calculation and distribution chart
  const fairValues = useFairValues();

  if (state.status === "loading" || clock === null) {
    return <p role="status">Loading markets…</p>;
  }
  if (state.status === "error") return <p role="alert">Could not load markets: {state.message}</p>;
  if (state.value.length === 0)
    return <p>No markets today. Markets are created each trading day.</p>;

  // After the early return above, clock is guaranteed to be a number.
  const now = clock;
  const cfg =
    config.status === "ready" ? config.value : { paused: false, overrideDelaySecs: 3_600n };
  const ctx = { nowSecs: now, paused: cfg.paused, overrideDelaySecs: cfg.overrideDelaySecs };
  const strikeData = (market: MarketRow): StrikeData => {
    const book = data.books[market.address];
    const fairValue = fairValues.byMarket[market.address];
    return {
      openedAt: null, // P0-4: Markets shows "Opened —"; Trade fetches real time
      ...(book?.state === "ready" ? { quotes: book.quotes } : {}),
      fair: fairValue,
      fairStatus: fairValues.status,
      fairRefreshFailed: fairValues.refreshFailed,
    };
  };
  const allGroups = groupByTicker(all);
  // Only when trading has stopped everywhere: an open market alongside a closed one keeps it hidden.
  const statuses = all.map((m) => marketStatus(m, now));
  const needsSettleNote =
    !statuses.some((s) => s === "Open" || s === "ClosingSoon") &&
    statuses.some((s) => s === "Closed" || s === "Settling" || s === "SettlementDelayed");
  return (
    <div className="space-y-mer-6">
      <Landing />
      <PageNotes showSettleNote={needsSettleNote} />
      {allGroups.map((group) => {
        const open: MarketRow[] = [];
        const closed: MarketRow[] = [];
        for (const market of group.markets) {
          const status = marketStatus(market, now);
          if (status === "Open" || status === "ClosingSoon") {
            open.push(market);
          } else {
            closed.push(market);
          }
        }
        return (
          <TickerLadder
            key={group.ticker}
            ticker={group.ticker}
            openMarkets={[...open].sort((a, b) =>
              a.strikeCents < b.strikeCents ? -1 : a.strikeCents > b.strikeCents ? 1 : 0,
            )}
            closedMarkets={[...closed].sort((a, b) =>
              a.strikeCents < b.strikeCents ? -1 : a.strikeCents > b.strikeCents ? 1 : 0,
            )}
            pythQuote={pythQuotes.quotes[group.ticker]}
            data={strikeData}
            ctx={ctx}
            {...(tradeHrefFn === undefined ? {} : { tradeHref: tradeHrefFn })}
          />
        );
      })}
    </div>
  );
}
