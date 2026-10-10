import { PythPrice, PythPricePlaceholder } from "../pyth-price";
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

/**
 * One ticker's strike ladder. The `h2` holds only the symbol; the live price, as-of time and the
 * strike count and close time are siblings in the header line, so the ticker list stays a clean
 * heading list and the table keeps exactly one header row and one row per strike.
 */
export function TickerLadder({
  ticker,
  markets,
  pythQuote,
  data,
  ctx,
  tradeHref,
}: {
  readonly ticker: string;
  /** Ascending strike. */
  readonly markets: readonly MarketRow[];
  /** Pyth live quote (M3-10, D-055: Pyth Pro is primary demo price source). */
  readonly pythQuote: PythQuote | undefined;
  readonly data: (market: MarketRow) => StrikeData;
  readonly ctx: BadgeContext;
  readonly tradeHref?: ((market: MarketRow) => string) | undefined;
}) {
  // Use Pyth quote for the live price marker (D-055: Pyth Pro is primary demo price source)
  const live = pythQuote === undefined ? null : BigInt(pythQuote.price_cents);
  const strikes = markets.map((market) => market.strikeCents);
  // The live price falls between the strike at or below it and the next one up.
  const belowIndex =
    live === null ? -1 : strikes.reduce((found, strike, i) => (strike <= live ? i : found), -1);
  const earliestClose = soonestOpenClose(markets, ctx.nowSecs);
  return (
    <section aria-label={ticker}>
      <div className="mb-mer-2 flex flex-wrap items-baseline gap-x-mer-4 gap-y-mer-1">
        <h2 className="text-mer-lg font-semibold">{ticker}</h2>
        {pythQuote === undefined ? (
          <PythPricePlaceholder />
        ) : (
          <PythPrice quote={pythQuote} nowMs={ctx.nowSecs * 1000} />
        )}
        <span className="text-mer-sm text-mer-ink-muted">
          {markets.length} strikes · closes {formatEtHm(earliestClose)} ET
        </span>
      </div>
      <table className="w-full text-mer-sm">
        <thead>
          <tr className="text-left text-mer-ink-muted">
            <th className="py-mer-1 pr-mer-3 font-medium">Strike</th>
            <th className="py-mer-1 pr-mer-3 font-medium">YES</th>
            <th className="py-mer-1 pr-mer-3 font-medium">NO</th>
            <th className="hidden py-mer-1 pr-mer-3 font-medium sm:table-cell">Probability</th>
            <th className="py-mer-1 pr-mer-3 font-medium">State</th>
            <th className="hidden py-mer-1 pr-mer-3 font-medium sm:table-cell">Opened · closes</th>
            <th className="py-mer-1 text-right font-medium">Pairs outstanding</th>
          </tr>
        </thead>
        <tbody>
          {markets.map((market, i) => (
            <StrikeRow
              key={market.address}
              market={market}
              data={data(market)}
              ctx={ctx}
              tradeHref={tradeHref}
              markerBelow={i === belowIndex}
              markerAbove={i === 0 && live !== null && belowIndex === -1}
            />
          ))}
        </tbody>
      </table>
    </section>
  );
}
