/**
 * Pyth quote data types and client adapter (M3-10, D-055).
 *
 * Pyth Pro is the primary demo price source. This module provides a typed interface
 * for Pyth price/quote data consumed by the UI. The backend implementation lives in
 * services/automation/src/pyth/ (MR !86, worker peak6-meridian-43).
 *
 * When !86 merges, this adapter will consume the real Pyth client through an API route.
 * Until then, it uses a mocked source for development and tests.
 */

import { z } from "zod";
import { MAG7, type Mag7Ticker } from "./market-data-shared";

export type { Mag7Ticker };

/**
 * Pyth feed IDs for MAG7 tickers.
 * Source: issue #49, programs/meridian/tests/fixtures/pyth/README.md
 */
export const PYTH_FEED_IDS: Record<Mag7Ticker, string> = {
  AAPL: "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
  AMZN: "0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a",
  GOOGL: "0x726c49cd73149a5eb8e5570d0e2cbf01c99853af3e5aeebd01e7eb6e1d15f977",
  META: "0x4b78d251770732f6304b1f41e9bebaabc3b256985ef18988f6de8d6562dd254c",
  MSFT: "0x4f1b1a0e68b8f1b5e1573eeb95e5b99fda76098146c66c1e5d3e7f0c94bc2294",
  NVDA: "0x6fa7e48602d2e6c0f46c1f2ef3d9d4b16d67a7a72f000a83aee12cb4e5d1c7a6",
  TSLA: "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc9641f1",
};

/**
 * Pyth quote: live price with confidence and publish time.
 */
export const pythQuoteSchema = z.object({
  ticker: z.enum(MAG7),
  /** Price in integer cents. */
  price_cents: z.number().int().positive(),
  /** Confidence interval in integer cents (price ± conf represents the uncertainty). */
  conf_cents: z.number().int().nonnegative(),
  /** Unix timestamp (seconds) when Pyth published this price. */
  publish_time: z.number().int().positive(),
  /** Feed ID (hex string). */
  feed_id: z.string(),
});
export type PythQuote = z.infer<typeof pythQuoteSchema>;

export const pythQuotesResponseSchema = z.object({
  quotes: z.array(pythQuoteSchema),
  /** Tickers that failed to fetch; never a made-up price. */
  unavailable: z.array(z.enum(MAG7)),
  /** Server timestamp (ms) when the response was generated. */
  server_time: z.number().int().positive(),
});
export type PythQuotesResponse = z.infer<typeof pythQuotesResponseSchema>;

/**
 * Freshness thresholds (milliseconds).
 * - Fresh: < 5 seconds old
 * - Stale: >= 5 seconds old
 */
export const PYTH_FRESHNESS_THRESHOLD_MS = 5_000;

/**
 * Determines if a Pyth quote is stale based on its publish time and current time.
 */
export function isPythQuoteStale(publishTimeSecs: number, nowMs: number): boolean {
  const ageMs = nowMs - publishTimeSecs * 1000;
  return ageMs >= PYTH_FRESHNESS_THRESHOLD_MS;
}

/**
 * Formats age of a quote for display.
 * Examples: "2s ago", "15s ago", "3m ago"
 */
export function formatQuoteAge(publishTimeSecs: number, nowMs: number): string {
  const ageMs = nowMs - publishTimeSecs * 1000;
  const ageSecs = Math.floor(ageMs / 1000);
  if (ageSecs < 60) {
    return `${ageSecs}s ago`;
  }
  const ageMin = Math.floor(ageSecs / 60);
  return `${ageMin}m ago`;
}
