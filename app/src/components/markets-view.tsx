"use client";

import { useEffect, useMemo, useState } from "react";

import { Landing, PageNotes } from "./markets/notes";
import { useMarketSources } from "./markets/data-context";
import { TickerLadder } from "./markets/ticker-ladder";
import type { StrikeData } from "./markets/strike-row";
import { useReader } from "./reader-context";
import { useAsync } from "./use-async";
import { useNow } from "./use-now";
import { useMarketData, type MarketDataSources } from "@/lib/market-data";
import { formatTradingDate, groupByTicker, marketStatus, type MarketRow } from "@/lib/markets";
import { activeDateMarkets, etTradingDate } from "@/lib/time";

/** Inert sources for pages without a data provider: nothing is live, so rows show "—". */
const NO_SOURCES: MarketDataSources = {
  fetchPrices: () => Promise.reject(new Error("no price source")),
  fetchBooks: () => Promise.resolve({}),
};

function useOpenTimes(markets: readonly MarketRow[]): Record<string, number | null> {
  const { openTimes } = useMarketSources();
  const [times, setTimes] = useState<Record<string, number | null>>({});
  const key = markets.map((m) => m.address).join(",");
  useEffect(() => {
    if (openTimes === null || key === "") return;
    let cancelled = false;
    void openTimes(key.split(",")).then((found) => {
      if (!cancelled) setTimes((previous) => ({ ...previous, ...found }));
    });
    return () => {
      cancelled = true;
    };
  }, [openTimes, key]);
  return times;
}

/**
 * Read-only list of on-chain markets as one strike ladder per ticker (FR-16, UI-03): the active
 * trading date's markets, YES / NO prices from the book, a state badge, the open and close time
 * in ET and a countdown to the next state change (D-050).
 */
export function MarketsView({
  nowSecs,
  tradeHref,
}: {
  readonly nowSecs?: number;
  /** Builds a strike's Trade link; absent until the Trade route exists (UI-04 turns it on). */
  readonly tradeHref?: (market: MarketRow) => string;
}) {
  const reader = useReader();
  const ticking = useNow();
  // `null` until the clock has mounted (server render and first paint): the date-dependent parts
  // wait for it rather than treating a missing clock as the unix epoch.
  const clock = nowSecs ?? ticking;
  const state = useAsync(() => reader.listMarkets(), [reader]);
  const config = useAsync(() => reader.getConfig(), [reader]);
  const sources = useMarketSources();
  const all = state.status === "ready" ? state.value : [];
  const active = useMemo(() => (clock === null ? [] : activeDateMarkets(all, clock)), [all, clock]);
  const data = useMarketData(active, sources.data ?? NO_SOURCES);
  const openTimes = useOpenTimes(active);

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
  const activeDate = active[0]?.tradingDate;
  const showingOld = activeDate !== undefined && activeDate !== etTradingDate(now);
  const needsSettleNote = active.some((m) => {
    const s = marketStatus(m, now);
    return s === "Closed" || s === "Settling" || s === "SettlementDelayed";
  });
  const strikeData = (market: MarketRow): StrikeData => {
    const book = data.books[market.address];
    return {
      openedAt: openTimes[market.address] ?? null,
      ...(book?.state === "ready" ? { quotes: book.quotes } : {}),
    };
  };
  return (
    <div className="space-y-mer-6">
      <Landing />
      {showingOld && activeDate !== undefined ? (
        <p className="text-mer-sm text-mer-ink-muted">
          Showing markets from {formatTradingDate(activeDate)} (closed)
        </p>
      ) : null}
      <PageNotes showSettleNote={needsSettleNote} />
      {groupByTicker(active).map((group) => (
        <TickerLadder
          key={group.ticker}
          ticker={group.ticker}
          markets={[...group.markets].sort((a, b) =>
            a.strikeCents < b.strikeCents ? -1 : a.strikeCents > b.strikeCents ? 1 : 0,
          )}
          price={data.prices[group.ticker as keyof typeof data.prices]}
          data={strikeData}
          ctx={ctx}
          tradeHref={tradeHref}
        />
      ))}
    </div>
  );
}
