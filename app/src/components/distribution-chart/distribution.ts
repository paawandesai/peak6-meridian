/**
 * Data for the implied-distribution chart (design.md § "Price, probability, fair value, edge"):
 * the strike ladder's YES prices read as P(close ≥ K), in strike order. Pure and integer-only.
 * A correct ladder never rises with the strike; where it does, that is a violation to show, not
 * to smooth away (M3-03 AC3).
 */
import type { BookQuotes } from "@meridian/client";

import type { MarketRow } from "@/lib/markets";

/** The displayed-price rule (design.md § "Displayed price rule"): a mid only for a tight book. */
export const MAX_SPREAD_CENTS = 10;

export type DistributionPoint = {
  readonly market: string;
  readonly strikeCents: bigint;
  /** The YES mid in cents, or `null` when the book is thin, wide or unreadable. */
  readonly yesCents: number | null;
  /** The fair YES in cents when the service priced this strike. */
  readonly fairCents: number | null;
};

export type Violation = {
  readonly lowerStrikeCents: bigint;
  readonly lowerYesCents: number;
  readonly higherStrikeCents: bigint;
  readonly higherYesCents: number;
};

/** The YES price shown for a market, or `null` (one-sided, crossed, or wider than 10¢). */
export function displayedYes(quotes: BookQuotes | null | undefined): number | null {
  if (quotes === null || quotes === undefined) return null;
  const { yesBid, yesAsk, yesMid } = quotes;
  if (yesBid === null || yesAsk === null || yesMid === null) return null;
  return yesAsk - yesBid <= MAX_SPREAD_CENTS ? yesMid : null;
}

/** One point per market of the ladder, ascending strike. */
export function distributionPoints(
  markets: readonly MarketRow[],
  quotes: Readonly<Record<string, BookQuotes | null | undefined>>,
  fair: Readonly<Record<string, number | undefined>>,
): DistributionPoint[] {
  return [...markets]
    .sort((a, b) => (a.strikeCents < b.strikeCents ? -1 : a.strikeCents > b.strikeCents ? 1 : 0))
    .map((market) => ({
      market: market.address,
      strikeCents: market.strikeCents,
      yesCents: displayedYes(quotes[market.address]),
      fairCents: fair[market.address] ?? null,
    }));
}

/**
 * Every adjacent pair (among priced strikes) where YES rises with the strike: P(close ≥ K) cannot
 * increase with K, so the higher strike priced above the lower one is a ladder inconsistency.
 */
export function violations(points: readonly DistributionPoint[]): Violation[] {
  const out: Violation[] = [];
  let previous: (DistributionPoint & { yesCents: number }) | null = null;
  for (const point of points) {
    if (point.yesCents === null) continue;
    const current = { ...point, yesCents: point.yesCents };
    if (previous !== null && current.yesCents > previous.yesCents) {
      out.push({
        lowerStrikeCents: previous.strikeCents,
        lowerYesCents: previous.yesCents,
        higherStrikeCents: current.strikeCents,
        higherYesCents: current.yesCents,
      });
    }
    previous = current;
  }
  return out;
}
