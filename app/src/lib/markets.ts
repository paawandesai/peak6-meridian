/** Market view model: status, grouping by ticker and display formatting. */
import { strikeCentsToDollars } from "@meridian/client";

/**
 * Market state per docs/design.md §3. The chain stores only Open or Settled; the rest is derived
 * from `close_ts` and the clock (an injected `nowSecs`, never read here). `Paused` is a global
 * flag (`Config.paused`), not a per-market status, so it is not part of this type.
 */
export type MarketStatus =
  "Open" | "ClosingSoon" | "Closed" | "Settling" | "SettlementDelayed" | "Settled";

/** Settlement outcome decoded from the `Market` account. */
export type MarketOutcome = "None" | "Yes" | "No";

/** "Closing soon" starts 15 minutes before `close_ts` (a UI threshold, design.md §3). */
export const CLOSING_SOON_SECS = 15n * 60n;
/** The settlement job's first attempt: `close_ts` + 5 minutes (domain.md). */
export const SETTLING_START_SECS = 5n * 60n;
/** The job's retry window ends 20 minutes after `close_ts`; after that settlement is delayed. */
export const SETTLEMENT_DELAYED_SECS = 20n * 60n;

export type MarketRow = {
  readonly address: string;
  readonly ticker: string;
  readonly tradingDate: number;
  readonly strikeCents: bigint;
  readonly closeTs: bigint;
  readonly settled: boolean;
  /** `None` until settled. */
  readonly outcome: MarketOutcome;
  /** Settle price with 18 fractional digits (`0n` until settled). */
  readonly settlePriceScaled: bigint;
  readonly pairsOutstanding: bigint;
};

export type TickerGroup = { readonly ticker: string; readonly markets: readonly MarketRow[] };

export function marketStatus(market: MarketRow, nowSecs: number): MarketStatus {
  if (market.settled) return "Settled";
  const now = BigInt(nowSecs);
  if (now < market.closeTs - CLOSING_SOON_SECS) return "Open";
  if (now < market.closeTs) return "ClosingSoon";
  if (now < market.closeTs + SETTLING_START_SECS) return "Closed";
  if (now < market.closeTs + SETTLEMENT_DELAYED_SECS) return "Settling";
  return "SettlementDelayed";
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
