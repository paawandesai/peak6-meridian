/**
 * Page copy that depends on the market's own times (design.md §2 Trade, §3 "How a strike
 * settles", D-050). Every time is `close_ts` (or the creation block time) rendered in ET through
 * `Intl`; none is hardcoded, so an early close reads 13:00 with no calendar in the app.
 */
import {
  SETTLING_START_SECS,
  formatStrike,
  formatTradingDate,
  type MarketRow,
} from "@/lib/markets";
import { formatUsdCents } from "@/lib/display";
import { etTradingDate, formatEtHm } from "@/lib/time";

export const MIDPOINT_NOTE =
  "Prices are the midpoint of the best bid and ask, not a price you can trade at. Buying costs the ask; selling pays the bid.";

/** `Will NVDA close at or above $180.00 at today's 16:00 ET close?` */
export function question(market: MarketRow, nowSecs: number): string {
  const strike = formatUsdCents(market.strikeCents);
  const close = formatEtHm(market.closeTs);
  const when =
    etTradingDate(nowSecs) === market.tradingDate
      ? `today's ${close} ET close`
      : `the ${formatTradingDate(market.tradingDate)} ${close} ET close`;
  return `Will ${market.ticker} close at or above ${strike} at ${when}?`;
}

/** The settlement rule under the question. */
export function settlementRule(market: MarketRow): string {
  return (
    "Settles on the average of two official closing prices (Tiingo and Twelve Data) for " +
    `${formatTradingDate(market.tradingDate)}. YES wins at or above ${formatUsdCents(market.strikeCents)}, NO wins below.`
  );
}

/** `Trading stops 16:00 ET · Settlement about 16:05 ET · Redeem after settlement` */
export function timeline(market: MarketRow): string {
  return (
    `Trading stops ${formatEtHm(market.closeTs)} ET · ` +
    `Settlement about ${formatEtHm(market.closeTs + SETTLING_START_SECS)} ET · Redeem after settlement`
  );
}

/** `Opened 09:00 ET · Closes 16:00 ET`; an unreadable creation time reads `—`. */
export function openClose(market: MarketRow, openTs: number | null): string {
  // A market created the evening before shows its date, so "Opened 18:00 ET" is never ambiguous.
  const date = openTs !== null && etTradingDate(openTs) !== market.tradingDate;
  const opened =
    openTs === null
      ? "—"
      : `${date ? `${formatTradingDate(etTradingDate(openTs))} ` : ""}${formatEtHm(openTs)} ET`;
  return `Opened ${opened} · Closes ${formatEtHm(market.closeTs)} ET`;
}

/** One-line meaning of YES and NO for first use on the page. */
export function sideMeanings(market: MarketRow): { yes: string; no: string } {
  const strike = formatStrike(market.strikeCents);
  return {
    yes: `pays $1.00 if ${market.ticker} closes at or above ${strike}`,
    no: `pays $1.00 if ${market.ticker} closes below ${strike}`,
  };
}
