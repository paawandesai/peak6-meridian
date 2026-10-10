/** Short market labels shared by the Portfolio tables. */
import { formatStrike, formatTradingDate, type MarketRow } from "@/lib/markets";

/** `NVDA ≥ $180 10/08` */
export function marketLabel(market: MarketRow): string {
  const [, month, day] = formatTradingDate(market.tradingDate).split("-");
  return `${market.ticker} ≥ ${formatStrike(market.strikeCents)} ${month}/${day}`;
}
