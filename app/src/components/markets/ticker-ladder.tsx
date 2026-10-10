import React from "react";

import { PythPrice, PythPricePlaceholder } from "../pyth-price";
import { PriceHistoryChart } from "../price-history-chart/price-history-chart";
import { StrikeRow, type StrikeData } from "./strike-row";
import type { PythQuote } from "@/lib/pyth-quotes";
import type { BadgeContext } from "@/lib/market-view";
import { type MarketRow } from "@/lib/markets";
import { yesView } from "@/lib/market-view";
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

/**
 * Splits open markets into sets by close time and picks the primary set: the soonest set whose
 * strikes bracket the live price (at the money), preferring the latest trading day; otherwise
 * the soonest set. Each set keeps
 * ascending strike order.
 */
export function closeSets(
  markets: readonly MarketRow[],
  live: bigint | null,
): { primary: readonly MarketRow[]; others: readonly (readonly MarketRow[])[] } {
  const byClose = new Map<bigint, MarketRow[]>();
  for (const m of markets) byClose.set(m.closeTs, [...(byClose.get(m.closeTs) ?? []), m]);
  const sets = [...byClose.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, rows]) => [...rows].sort((a, b) => (a.strikeCents < b.strikeCents ? -1 : 1)));
  if (sets.length === 0) return { primary: [], others: [] };
  const brackets = (rows: readonly MarketRow[]) =>
    live !== null &&
    (rows[0]?.strikeCents ?? 0n) <= live &&
    live <= (rows[rows.length - 1]?.strikeCents ?? 0n);
  // Prefer the latest trading day's at-the-money set (today's), then the soonest close.
  const day = (rows: readonly MarketRow[]) => rows[0]?.tradingDate ?? 0;
  let pick = 0;
  let best = -1;
  sets.forEach((rows, i) => {
    if (brackets(rows) && day(rows) > best) {
      best = day(rows);
      pick = i;
    }
  });
  return { primary: sets[pick] ?? [], others: sets.filter((_, i) => i !== pick) };
}

/**
 * One ticker's strike ladder. The `h2` holds only the symbol; the live price, as-of time and the
 * strike count and close time are siblings in the header line, so the ticker list stays a clean
 * heading list and the table keeps exactly one header row and one row per strike. Closed markets
 * appear in a collapsed section below the open markets.
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
  const { primary, others } = closeSets(openMarkets, live);
  const openStrikes = primary.map((market) => market.strikeCents);
  const anyQuote = [...openMarkets, ...closedMarkets].some(
    (m) => yesView(data(m).quotes).kind !== "none",
  );
  // The live price falls between the strike at or below it and the next one up (only for open markets)
  const belowIndex =
    live === null ? -1 : openStrikes.reduce((found, strike, i) => (strike <= live ? i : found), -1);
  const earliestClose = primary.length > 0 ? soonestOpenClose(primary, ctx.nowSecs) : 0n;
  const totalMarkets = openMarkets.length + closedMarkets.length;

  const renderMarketRow = (market: MarketRow, i: number, showPriceMarker: boolean) => {
    // Insert Pyth price row between strikes when live price falls between them (only for open markets)
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
  };

  const strikes = (primary.length > 0 ? primary : closedMarkets).map((m) => m.strikeCents);
  const head = (
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
  );
  const collapsed = (label: string, rows: readonly MarketRow[], key: string) => (
    <details key={key} className="mt-mer-2">
      <summary className="cursor-pointer text-mer-sm text-mer-ink-muted">
        {label} ({rows.length} strikes)
      </summary>
      <table className="w-full text-mer-sm">
        {head}
        <tbody>{rows.map((m, i) => renderMarketRow(m, i, false))}</tbody>
      </table>
    </details>
  );

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
            {primary.length} strikes · closes {formatEtHm(earliestClose)} ET
            {totalMarkets > primary.length ? ` · ${totalMarkets - primary.length} more below` : ""}
          </span>
        ) : (
          <span className="text-mer-sm text-mer-ink-muted">{totalMarkets} strikes</span>
        )}
      </div>
      <div className="mb-mer-4">
        <PriceHistoryChart ticker={ticker} nowSecs={ctx.nowSecs} strikes={strikes} />
      </div>
      {!anyQuote && totalMarkets > 0 ? (
        <p className="mb-mer-2 text-mer-xs text-mer-ink-muted">
          No quotes yet: odds appear when the market maker posts.
        </p>
      ) : null}
      {primary.length > 0 ? (
        <table className="w-full text-mer-sm">
          {head}
          <tbody>{primary.map((m, i) => renderMarketRow(m, i, true))}</tbody>
        </table>
      ) : null}
      {others.map((rows) =>
        collapsed(
          `Closes ${formatEtHm(rows[0]?.closeTs ?? 0n)} ET`,
          rows,
          `set-${rows[0]?.closeTs ?? 0n}`,
        ),
      )}
      {closedMarkets.length > 0 ? collapsed("Closed", closedMarkets, "closed") : null}
    </section>
  );
}
