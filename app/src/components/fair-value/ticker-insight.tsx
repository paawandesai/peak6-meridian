"use client";

import { DistributionChart } from "@/components/distribution-chart/distribution-chart";
import { displayedYes, distributionPoints } from "@/components/distribution-chart/distribution";
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

/** Pure view: the fair value and edge for `market`, and the ticker's distribution chart. */
export function TickerInsightView({ market, ladder, books, fair, nowSecs }: ViewProps) {
  const quotes = Object.fromEntries(
    Object.entries(books).map(([address, book]) => [
      address,
      book.state === "ready" ? book.quotes : null,
    ]),
  );
  const fairByMarket = Object.fromEntries(
    Object.entries(fair.byMarket).map(([address, value]) => [address, value.fair_cents]),
  );
  const points = distributionPoints(ladder, quotes, fairByMarket);
  const own = quotes[market.address];
  return (
    <section aria-labelledby="fair-heading" className="grid gap-mer-4">
      <h2 id="fair-heading" className="text-mer-lg font-semibold">
        Fair value
      </h2>
      <FairEdge
        yesCents={displayedYes(own)}
        fair={fair.byMarket[market.address]}
        status={fair.status}
        refreshFailed={fair.refreshFailed}
        nowSecs={nowSecs}
      />
      <DistributionChart ticker={market.ticker} points={points} />
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
