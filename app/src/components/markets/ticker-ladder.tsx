import { AsOf } from "../ui";
import { StrikeRow, type StrikeData } from "./strike-row";
import type { LivePrice } from "@/lib/market-data";
import { formatUsdCents } from "@/lib/display";
import type { BadgeContext } from "@/lib/market-view";
import { type MarketRow } from "@/lib/markets";
import { formatEtHm, formatEtHms } from "@/lib/time";

/**
 * One ticker's strike ladder. The `h2` holds only the symbol; the live price, as-of time and the
 * strike count and close time are siblings in the header line, so the ticker list stays a clean
 * heading list and the table keeps exactly one header row and one row per strike.
 */
export function TickerLadder({
  ticker,
  markets,
  price,
  data,
  ctx,
  tradeHref,
}: {
  readonly ticker: string;
  /** Ascending strike. */
  readonly markets: readonly MarketRow[];
  readonly price: LivePrice | undefined;
  readonly data: (market: MarketRow) => StrikeData;
  readonly ctx: BadgeContext;
  readonly tradeHref?: ((market: MarketRow) => string) | undefined;
}) {
  const live = price === undefined ? null : BigInt(price.price_cents);
  const strikes = markets.map((market) => market.strikeCents);
  // The live price falls between the strike at or below it and the next one up.
  const belowIndex =
    live === null ? -1 : strikes.reduce((found, strike, i) => (strike <= live ? i : found), -1);
  const earliestClose = markets.reduce(
    (min, m) => (m.closeTs < min ? m.closeTs : min),
    markets[0]?.closeTs ?? 0n,
  );
  const asOfSecs = price === undefined ? null : Math.floor(Date.parse(price.as_of) / 1000);
  return (
    <section aria-label={ticker}>
      <div className="mb-mer-2 flex flex-wrap items-baseline gap-x-mer-4 gap-y-mer-1">
        <h2 className="text-mer-lg font-semibold">{ticker}</h2>
        {price === undefined || asOfSecs === null ? (
          <span className="text-mer-sm text-mer-ink-muted">— price not live yet</span>
        ) : (
          <span className="flex flex-wrap items-baseline gap-x-mer-2">
            <span className="mer-num text-mer-md font-medium">
              {formatUsdCents(BigInt(price.price_cents))}
            </span>
            <AsOf
              time={formatEtHms(asOfSecs)}
              ageSecs={Math.max(0, ctx.nowSecs - asOfSecs) + (price.stale ? 11 : 0)}
            />
          </span>
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
