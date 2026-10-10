import React from "react";

import { PythPrice, PythPricePlaceholder } from "../pyth-price";
import { PriceHistoryChart } from "../price-history-chart/price-history-chart";
import { StrikeRow, type StrikeData } from "./strike-row";
import type { PythQuote } from "@/lib/pyth-quotes";
import type { BadgeContext } from "@/lib/market-view";
import { type MarketRow } from "@/lib/markets";
import { formatEtHm } from "@/lib/time";

/**
 * The header close time: the soonest close among markets still trading (close in the future);
 * when none are open, the earliest close overall.
 */
export function soonestOpenClose(markets: readonly MarketRow[], nowSecs: number): bigint {
  const now = BigInt(Math.floor(nowSecs));
  const min = (list: readonly MarketRow[]) =>
    list.reduce<bigint | null>((m, row) => (m === null || row.closeTs < m ? row.closeTs : m), null);
  return min(markets.filter((m) => !m.settled && m.closeTs > now)) ?? min(markets) ?? 0n;
}

type MarketGroup = {
  readonly closeTs: bigint;
  readonly markets: readonly MarketRow[];
};

/**
 * Group markets by close time, find at-the-money set (strikes bracket live price).
 * Returns groups sorted by close time (soonest first), with ATM flag.
 */
function groupByCloseTime(
  markets: readonly MarketRow[],
  livePrice: bigint | null,
): Array<MarketGroup & { readonly isAtm: boolean }> {
  const byClose = new Map<string, MarketRow[]>();
  for (const market of markets) {
    const key = market.closeTs.toString();
    byClose.set(key, [...(byClose.get(key) ?? []), market]);
  }
  const groups = Array.from(byClose.entries())
    .map(([, markets]) => {
      const first = markets[0];
      if (!first) return null;
      return {
        closeTs: first.closeTs,
        markets: [...markets].sort((a, b) =>
          a.strikeCents < b.strikeCents ? -1 : a.strikeCents > b.strikeCents ? 1 : 0,
        ),
      };
    })
    .filter((g): g is NonNullable<typeof g> => g !== null)
    .sort((a, b) => (a.closeTs < b.closeTs ? -1 : a.closeTs > b.closeTs ? 1 : 0));

  // Find ATM group: strikes bracket live price among soonest groups
  let atmIndex = 0;
  if (livePrice !== null) {
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (!group) continue;
      const strikes = group.markets.map((m) => m.strikeCents);
      const brackets =
        strikes.some((s) => s <= livePrice) && strikes.some((s) => s >= livePrice);
      if (brackets) {
        atmIndex = i;
        break;
      }
    }
  }

  return groups.map((g, i) => ({ ...g, isAtm: i === atmIndex }));
}

/**
 * One ticker's strike ladder grouped by close time. The soonest at-the-money set (strikes
 * bracket live price) is shown first and expanded; other sets are in collapsed sections.
 */
export function TickerLadder({
  ticker,
  openMarkets,
  closedMarkets,
  pythQuote,
  data,
  ctx,
  tradeHref,
}: {
  readonly ticker: string;
  /** Ascending strike. Open markets (Open or ClosingSoon). */
  readonly openMarkets: readonly MarketRow[];
  /** Ascending strike. Closed/Settling/SettlementDelayed/Settled markets. */
  readonly closedMarkets: readonly MarketRow[];
  /** Pyth live quote (M3-10, D-055: Pyth Pro is primary demo price source). */
  readonly pythQuote: PythQuote | undefined;
  readonly data: (market: MarketRow) => StrikeData;
  readonly ctx: BadgeContext;
  readonly tradeHref?: ((market: MarketRow) => string) | undefined;
}) {
  // Use Pyth quote for the live price marker (D-055: Pyth Pro is primary demo price source)
  const live = pythQuote === undefined ? null : BigInt(pythQuote.price_cents);
  const openGroups = groupByCloseTime(openMarkets, live);
  const closedGroups = groupByCloseTime(closedMarkets, null);
  const earliestClose = openMarkets.length > 0 ? soonestOpenClose(openMarkets, ctx.nowSecs) : 0n;
  const totalMarkets = openMarkets.length + closedMarkets.length;

  // Check if all markets have no quotes (show "No quotes yet" note instead of empty bars)
  const allMarketsNoQuotes = [...openMarkets, ...closedMarkets].every((m) => {
    const strikeData = data(m);
    return strikeData.quotes === null || strikeData.quotes === undefined;
  });

  const renderGroup = (group: MarketGroup, showPriceMarker: boolean) => {
    const groupStrikes = group.markets.map((m) => m.strikeCents);
    const belowIndex =
      live === null
        ? -1
        : groupStrikes.reduce((found, strike, i) => (strike <= live ? i : found), -1);

    return group.markets.map((market, i) => {
      const showPriceRowBefore = showPriceMarker && i === 0 && live !== null && belowIndex === -1;
      const showPriceRowAfter = showPriceMarker && i === belowIndex && live !== null;
      return (
        <React.Fragment key={market.address}>
          {showPriceRowBefore && pythQuote !== undefined ? (
            <tr
              key={`pyth-above-${market.address}`}
              className="border-t-2 border-dashed border-mer-warn"
            >
              <td colSpan={8} className="py-mer-1 text-mer-xs text-mer-ink-muted">
                <PythPrice quote={pythQuote} nowMs={ctx.nowSecs * 1000} showLabel />
              </td>
            </tr>
          ) : null}
          <StrikeRow
            market={market}
            data={data(market)}
            ctx={ctx}
            tradeHref={tradeHref}
            markerBelow={false}
            markerAbove={false}
          />
          {showPriceRowAfter && pythQuote !== undefined ? (
            <tr
              key={`pyth-below-${market.address}`}
              className="border-t-2 border-dashed border-mer-warn"
            >
              <td colSpan={8} className="py-mer-1 text-mer-xs text-mer-ink-muted">
                <PythPrice quote={pythQuote} nowMs={ctx.nowSecs * 1000} showLabel />
              </td>
            </tr>
          ) : null}
        </React.Fragment>
      );
    });
  };

  const allMarkets = [...openMarkets, ...closedMarkets];
  const strikes = allMarkets.map((m) => m.strikeCents);
  const atmGroup = openGroups.find((g) => g.isAtm);
  const otherOpenGroups = openGroups.filter((g) => !g.isAtm);

  return (
    <section aria-label={ticker}>
      <div className="mb-mer-2 flex flex-wrap items-baseline gap-x-mer-4 gap-y-mer-1">
        <h2 className="text-mer-lg font-semibold">{ticker}</h2>
        {pythQuote === undefined ? (
          <PythPricePlaceholder />
        ) : (
          <PythPrice quote={pythQuote} nowMs={ctx.nowSecs * 1000} />
        )}
        {openMarkets.length > 0 ? (
          <span className="text-mer-sm text-mer-ink-muted">
            {totalMarkets} strikes · closes {formatEtHm(earliestClose)} ET
          </span>
        ) : (
          <span className="text-mer-sm text-mer-ink-muted">{totalMarkets} strikes</span>
        )}
      </div>
      <div className="mb-mer-4">
        <PriceHistoryChart ticker={ticker} nowSecs={ctx.nowSecs} strikes={strikes} />
      </div>
      {allMarketsNoQuotes && (
        <p className="mb-mer-4 text-mer-sm text-mer-ink-muted">
          No quotes yet; odds appear when the market maker posts.
        </p>
      )}
      <table className="w-full text-mer-sm">
        <thead>
          <tr className="text-left text-mer-ink-muted">
            <th className="py-mer-1 pr-mer-3 font-medium">Strike</th>
            <th className="py-mer-1 pr-mer-3 font-medium">YES</th>
            <th className="py-mer-1 pr-mer-3 font-medium">NO</th>
            <th className="py-mer-1 pr-mer-3 font-medium">Fair · Edge</th>
            <th className="hidden py-mer-1 pr-mer-3 font-medium sm:table-cell">Probability</th>
            <th className="py-mer-1 pr-mer-3 font-medium">State</th>
            <th className="hidden py-mer-1 pr-mer-3 font-medium sm:table-cell">Opened · closes</th>
            <th className="py-mer-1 text-right font-medium">Pairs outstanding</th>
          </tr>
        </thead>
        <tbody>
          {/* ATM group first (expanded) */}
          {atmGroup && renderGroup(atmGroup, true)}
          {/* Other open groups in collapsed sections */}
          {otherOpenGroups.map((group) => (
            <React.Fragment key={group.closeTs.toString()}>
              <tr>
                <td colSpan={8} className="py-mer-2">
                  <details className="group">
                    <summary className="cursor-pointer text-mer-sm text-mer-ink-muted hover:text-mer-ink">
                      Closes {formatEtHm(group.closeTs)} ET ({group.markets.length} strikes)
                    </summary>
                    <table className="mt-mer-2 w-full text-mer-sm">
                      <tbody>{renderGroup(group, true)}</tbody>
                    </table>
                  </details>
                </td>
              </tr>
            </React.Fragment>
          ))}
          {/* Closed markets in collapsed section */}
          {closedGroups.length > 0 && (
            <tr>
              <td colSpan={8} className="py-mer-2">
                <details className="group">
                  <summary className="cursor-pointer text-mer-sm text-mer-ink-muted hover:text-mer-ink">
                    Closed markets ({closedMarkets.length} strikes)
                  </summary>
                  <table className="mt-mer-2 w-full text-mer-sm">
                    <tbody>
                      {closedGroups.flatMap((group) => renderGroup(group, false))}
                    </tbody>
                  </table>
                </details>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
