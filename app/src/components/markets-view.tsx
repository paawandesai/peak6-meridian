"use client";

import Link from "next/link";

import { useReader } from "./reader-context";
import { useAsync } from "./use-async";
import {
  formatStrike,
  formatTradingDate,
  groupByTicker,
  marketStatus,
  type MarketRow,
} from "@/lib/markets";
import { tradeHref } from "@/app/trade/_lib/href";

const STATUS_STYLE = {
  Open: "bg-emerald-100 text-emerald-800",
  ClosingSoon: "bg-amber-100 text-amber-800",
  Closed: "bg-amber-100 text-amber-800",
  Settling: "bg-amber-100 text-amber-800",
  SettlementDelayed: "bg-amber-100 text-amber-800",
  Settled: "bg-slate-200 text-slate-700",
} as const;

/** Plain-word label for each status (UI-03 replaces this table with `StateBadge`). */
const STATUS_TEXT = {
  Open: "Open",
  ClosingSoon: "Closing soon",
  Closed: "Closed",
  Settling: "Settling…",
  SettlementDelayed: "Settlement delayed",
  Settled: "Settled",
} as const;

function MarketTable({ markets, nowSecs }: { markets: readonly MarketRow[]; nowSecs: number }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-slate-500">
          <th className="py-1 font-medium">Strike</th>
          <th className="py-1 font-medium">Date</th>
          <th className="py-1 font-medium">Status</th>
          <th className="py-1 text-right font-medium">Pairs outstanding</th>
        </tr>
      </thead>
      <tbody>
        {markets.map((market) => {
          const status = marketStatus(market, nowSecs);
          return (
            <tr key={market.address} className="border-t border-slate-200">
              <td className="py-1.5 font-mono">
                <Link href={tradeHref(market)} className="hover:underline">
                  {formatStrike(market.strikeCents)}
                </Link>
              </td>
              <td className="py-1.5">{formatTradingDate(market.tradingDate)}</td>
              <td className="py-1.5">
                <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLE[status]}`}>
                  {STATUS_TEXT[status]}
                </span>
              </td>
              <td className="py-1.5 text-right font-mono">
                {market.pairsOutstanding.toLocaleString("en-US")}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Read-only list of on-chain markets, grouped by ticker (FR-16). */
export function MarketsView({ nowSecs = Math.floor(Date.now() / 1000) }: { nowSecs?: number }) {
  const reader = useReader();
  const state = useAsync(() => reader.listMarkets(), [reader]);

  if (state.status === "loading") {
    return <p role="status">Loading markets…</p>;
  }
  if (state.status === "error") {
    return <p role="alert">Could not load markets: {state.message}</p>;
  }
  if (state.value.length === 0) {
    return <p>No markets yet. Markets are created each trading day.</p>;
  }
  return (
    <div className="space-y-6">
      {groupByTicker(state.value).map((group) => (
        <section key={group.ticker} aria-label={group.ticker}>
          <h2 className="mb-2 text-lg font-semibold">{group.ticker}</h2>
          <MarketTable markets={group.markets} nowSecs={nowSecs} />
        </section>
      ))}
    </div>
  );
}
