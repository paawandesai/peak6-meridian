/**
 * Types and pure helpers shared by the market-data route (server) and the hook (client).
 * Nothing here reads the environment, so importing it can never pull a server variable name
 * into the browser bundle.
 */
import { z } from "zod";

/** The seven tickers (docs/domain.md). */
export const MAG7 = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] as const;
export type Mag7Ticker = (typeof MAG7)[number];

export const livePriceSchema = z.object({
  ticker: z.enum(MAG7),
  /** Integer cents of the last price. */
  price_cents: z.number().int().positive(),
  /** ISO-8601 time the upstream reported the price. */
  as_of: z.iso.datetime(),
  /** True when this is the last known price because the upstream failed. */
  stale: z.boolean(),
});
export type LivePrice = z.infer<typeof livePriceSchema>;

export const marketDataResponseSchema = z.object({
  prices: z.array(livePriceSchema),
  /** Tickers with no price at all (upstream down and nothing cached); never a made-up price. */
  unavailable: z.array(z.enum(MAG7)),
});
export type MarketDataResponse = z.infer<typeof marketDataResponseSchema>;

/**
 * A dollar amount from an upstream JSON number → integer cents, or `null` if it is not a
 * positive finite price of at most $1,000,000. Goes through a two-decimal string so no
 * floating-point multiplication is involved.
 */
export function dollarsToCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1_000_000) {
    return null;
  }
  const cents = Number(value.toFixed(2).replace(".", ""));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}
