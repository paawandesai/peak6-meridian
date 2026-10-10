"use client";

import { displayedYes } from "@/components/distribution-chart/distribution";
import { PriceHistoryChart } from "@/components/price-history-chart/price-history-chart";
import { FairEdge } from "./fair-edge";
import { type FairValues, useFairValues } from "@/lib/fair-values";
import type { MarketBook } from "@/lib/market-data";
import { marketStatus, type MarketRow } from "@/lib/markets";

type ViewProps = {
  readonly market: MarketRow;
  /** Every market of the same ticker and trading date (the ladder). */
  readonly ladder: readonly MarketRow[];
  readonly books: Readonly<Record<string, MarketBook>>;
  readonly fair: FairValues;
  readonly nowSecs: number;
};

/** Pure view: the fair value and edge for `market`, and the ticker's price history chart. */
export function TickerInsightView({ market, books, fair, nowSecs }: ViewProps) {
  const own = books[market.address];
  const quotes = own?.state === "ready" ? own.quotes : null;
  const yesCents = displayedYes(quotes);
  const headingId = `fair-heading-${market.ticker}`;
  const marketFair = fair.byMarket[market.address];
  return (
    <section aria-labelledby={headingId} className="grid gap-mer-4">
      <h2 id={headingId} className="text-mer-lg font-semibold">
        Fair value
      </h2>
      <FairEdge
        yesCents={yesCents}
        fair={marketFair}
        status={fair.status}
        refreshFailed={fair.refreshFailed}
        nowSecs={nowSecs}
      />
      <PriceHistoryChart ticker={market.ticker} nowSecs={nowSecs} />
    </section>
  );
}

/**
 * The Trade page's mount (M3-03): reads fair values every 5 s while any market of the ladder is
 * open, and the books come from the page's market data.
 */
export function TickerInsight(props: Omit<ViewProps, "fair">) {
  const anyOpen = props.ladder.some((m) => marketStatus(m, props.nowSecs) !== "Settled");
  const fair = useFairValues({ enabled: anyOpen });
  return <TickerInsightView {...props} fair={fair} />;
}
