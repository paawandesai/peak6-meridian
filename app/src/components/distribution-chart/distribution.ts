/**
 * Data for the implied-distribution chart (design.md § "Price, probability, fair value, edge"):
 * the strike ladder's YES prices read as P(close ≥ K), in strike order, and the bucket
 * probabilities between adjacent strikes that follow from them. Pure and integer-only.
 * A correct ladder never rises with the strike; where it does, that is a violation to show in
 * words (M3-03 AC3). The buckets are drawn from a monotone-corrected copy so no bucket is
 * negative, and the chart says when that correction was applied.
 */
import type { BookQuotes } from "@meridian/client";

import { asOfSecs, type FairValue, isStale } from "@/lib/fair-values-core";
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
  /** The fair value is the service's last one, flagged stale (shown, not hidden). */
  readonly fairStale?: boolean;
  /** When the fair value was computed (unix seconds), for the stale tag's age. */
  readonly fairAsOfSecs?: number | null;
};

/** Per market: is its fair value stale, and when was it computed. */
export type FairStaleness = { readonly stale: boolean; readonly asOfSecs: number };

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

/**
 * Per market, whether its fair value is stale (the service says so, it is old, or the last
 * refresh failed) and when it was computed. A stale value is still drawn and tabled, flagged.
 */
export function fairStaleness(
  byMarket: Readonly<Record<string, FairValue>>,
  refreshFailed: boolean,
  nowSecs: number,
): Record<string, FairStaleness> {
  return Object.fromEntries(
    Object.entries(byMarket).map(([address, value]) => [
      address,
      { stale: refreshFailed || isStale(value, nowSecs), asOfSecs: asOfSecs(value) },
    ]),
  );
}

/** One point per market of the ladder, ascending strike. `staleness` flags stale fair values. */
export function distributionPoints(
  markets: readonly MarketRow[],
  quotes: Readonly<Record<string, BookQuotes | null | undefined>>,
  fair: Readonly<Record<string, number | undefined>>,
  staleness: Readonly<Record<string, FairStaleness | undefined>> = {},
): DistributionPoint[] {
  return [...markets]
    .sort((a, b) => (a.strikeCents < b.strikeCents ? -1 : a.strikeCents > b.strikeCents ? 1 : 0))
    .map((market) => ({
      market: market.address,
      strikeCents: market.strikeCents,
      yesCents: displayedYes(quotes[market.address]),
      fairCents: fair[market.address] ?? null,
      fairStale: staleness[market.address]?.stale === true,
      fairAsOfSecs: staleness[market.address]?.asOfSecs ?? null,
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

/**
 * The closest non-increasing sequence (least squares, pool-adjacent-violators), each value rounded
 * half-up to whole cents and clamped to 0..100. Rounding a pooled block keeps it constant and
 * rounding is monotone, so the result never rises. A sequence that already never rises (within
 * 0..100) comes back unchanged. Integer arithmetic only.
 */
export function monotoneSurvival(values: readonly number[]): number[] {
  const blocks: { sum: number; count: number }[] = [];
  for (const raw of values) {
    blocks.push({ sum: Math.min(100, Math.max(0, raw)), count: 1 });
    // A later block averaging above the one before it breaks the order: pool the two.
    let last = blocks[blocks.length - 1];
    let prev = blocks[blocks.length - 2];
    while (
      last !== undefined &&
      prev !== undefined &&
      last.sum * prev.count > prev.sum * last.count
    ) {
      blocks.splice(blocks.length - 2, 2, {
        sum: prev.sum + last.sum,
        count: prev.count + last.count,
      });
      last = blocks[blocks.length - 1];
      prev = blocks[blocks.length - 2];
    }
  }
  return blocks.flatMap(({ sum, count }) =>
    Array.from({ length: count }, () => Math.floor((2 * sum + count) / (2 * count))),
  );
}

/** One bucket of the distribution: the chance the close lands in [lower, upper). */
export type Bucket = {
  /** `null` for the bottom tail (below the lowest strike). */
  readonly lowerStrikeCents: bigint | null;
  /** `null` for the top tail (at or above the highest strike). */
  readonly upperStrikeCents: bigint | null;
  /** Probability in whole percent, or `null` when an edge strike has no price. */
  readonly percent: number | null;
};

/**
 * Bucket probabilities from P(close ≥ K) by strike (ascending, `null` = unpriced): below the
 * lowest strike `100 − P₁`, between adjacent strikes `Pᵢ − Pᵢ₊₁`, at or above the highest `Pₙ`.
 * The priced values are monotone-corrected first ({@link monotoneSurvival}), so every bucket is
 * 0..100 and, when every strike is priced, they sum to exactly 100. A bucket with an unpriced
 * edge is `null`: its mass is not guessed.
 */
export function bucketProbabilities(
  strikes: readonly bigint[],
  survival: readonly (number | null)[],
): Bucket[] {
  if (strikes.length === 0) return [];
  const pricedIdx = strikes.flatMap((_, i) => {
    const value = survival[i];
    return value === null || value === undefined ? [] : [i];
  });
  const corrected = monotoneSurvival(pricedIdx.map((i) => survival[i] ?? 0));
  const p: (number | null)[] = strikes.map(() => null);
  pricedIdx.forEach((i, k) => {
    p[i] = corrected[k] ?? null;
  });
  const at = (i: number): number | null => p[i] ?? null;
  const out: Bucket[] = [];
  const first = at(0);
  out.push({
    lowerStrikeCents: null,
    upperStrikeCents: strikes[0] ?? null,
    percent: first === null ? null : 100 - first,
  });
  for (let i = 0; i + 1 < strikes.length; i += 1) {
    const lo = at(i);
    const hi = at(i + 1);
    out.push({
      lowerStrikeCents: strikes[i] ?? null,
      upperStrikeCents: strikes[i + 1] ?? null,
      percent: lo === null || hi === null ? null : lo - hi,
    });
  }
  out.push({
    lowerStrikeCents: strikes[strikes.length - 1] ?? null,
    upperStrikeCents: null,
    percent: at(strikes.length - 1),
  });
  return out;
}

/** The market's and the fair value's buckets for the same strikes, side by side. */
export type DistributionBucket = {
  readonly lowerStrikeCents: bigint | null;
  readonly upperStrikeCents: bigint | null;
  readonly marketPercent: number | null;
  readonly fairPercent: number | null;
};

export function distributionBuckets(points: readonly DistributionPoint[]): DistributionBucket[] {
  const strikes = points.map((point) => point.strikeCents);
  const market = bucketProbabilities(
    strikes,
    points.map((point) => point.yesCents),
  );
  const fair = bucketProbabilities(
    strikes,
    points.map((point) => point.fairCents),
  );
  return market.map((bucket, i) => ({
    lowerStrikeCents: bucket.lowerStrikeCents,
    upperStrikeCents: bucket.upperStrikeCents,
    marketPercent: bucket.percent,
    fairPercent: fair[i]?.percent ?? null,
  }));
}
