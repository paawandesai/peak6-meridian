/** Fixtures for the fair-value tests. */
import type { BookQuotes } from "@meridian/client";

import type { MarketBook } from "@/lib/market-data";
import type { FairValue } from "@/lib/fair-values";
import { market } from "@/test-utils";
import type { MarketRow } from "@/lib/markets";

/** 2026-10-08 during the trading day. */
export const NOW = 1_791_480_000;

export function fair(overrides: Partial<FairValue> = {}): FairValue {
  return {
    market: "Mkt1111111111111111111111111111111111111111",
    ticker: "NVDA",
    strike_cents: 18_000,
    fair_cents: 58,
    sigma: 0.32,
    spot: "181.42",
    as_of: new Date((NOW - 2) * 1000).toISOString(),
    stale: false,
    ...overrides,
  };
}

export const quotes = (bid: number | null, ask: number | null): BookQuotes => ({
  yesBid: bid,
  yesAsk: ask,
  yesMid: bid !== null && ask !== null && bid <= ask ? Math.floor((bid + ask) / 2) : null,
  noPrice: null,
});

export const ready = (bid: number | null, ask: number | null): MarketBook => ({
  state: "ready",
  quotes: quotes(bid, ask),
});

/** A ladder of NVDA strikes ($170, $180, $190) with addresses `A170`… */
export function ladder(): MarketRow[] {
  return [190, 170, 180].map((dollars) =>
    market({
      address: `Mkt${dollars}`.padEnd(44, "1"),
      ticker: "NVDA",
      strikeCents: BigInt(dollars * 100),
      tradingDate: 20261008,
      closeTs: 1_791_489_600n,
    }),
  );
}
