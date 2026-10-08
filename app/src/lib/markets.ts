/** Market view model: status, grouping by ticker and display formatting. */
import { strikeCentsToDollars } from "@meridian/client";

/** `Closed` is derived (`now >= closeTs` and not settled); the chain stores Open or Settled. */
export type MarketStatus = "Open" | "Closed" | "Settled";

export type MarketRow = {
  readonly address: string;
  readonly ticker: string;
  readonly tradingDate: number;
  readonly strikeCents: bigint;
  readonly closeTs: bigint;
  readonly settled: boolean;
  readonly pairsOutstanding: bigint;
};

export type TickerGroup = { readonly ticker: string; readonly markets: readonly MarketRow[] };

export function marketStatus(market: MarketRow, nowSecs: number): MarketStatus {
  if (market.settled) return "Settled";
  return BigInt(nowSecs) >= market.closeTs ? "Closed" : "Open";
}

/** Groups by ticker (alphabetical), newest trading date first, then ascending strike. */
export function groupByTicker(markets: readonly MarketRow[]): TickerGroup[] {
  const byTicker = new Map<string, MarketRow[]>();
  for (const market of markets) {
    byTicker.set(market.ticker, [...(byTicker.get(market.ticker) ?? []), market]);
  }
  return [...byTicker.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ticker, rows]) => ({
      ticker,
      markets: [...rows].sort(
        (a, b) =>
          b.tradingDate - a.tradingDate ||
          (a.strikeCents < b.strikeCents ? -1 : a.strikeCents > b.strikeCents ? 1 : 0),
      ),
    }));
}

/** Strike in whole dollars ("$680"); strikes are multiples of $10 so there is no remainder. */
export function formatStrike(strikeCents: bigint): string {
  return `$${strikeCentsToDollars(strikeCents).toLocaleString("en-US")}`;
}

/** `YYYYMMDD` → "YYYY-MM-DD". */
export function formatTradingDate(value: number): string {
  const text = String(value).padStart(8, "0");
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}
