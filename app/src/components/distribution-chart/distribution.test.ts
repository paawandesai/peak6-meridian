import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  bucketProbabilities,
  displayedYes,
  distributionBuckets,
  distributionPoints,
  fairStaleness,
  MAX_SPREAD_CENTS,
  monotoneSurvival,
  violations,
} from "./distribution";
import { fair, ladder, NOW, quotes } from "@/components/fair-value/test-support";

describe("displayedYes (the displayed-price rule)", () => {
  it("is the integer-floor mid for a tight book", () => {
    expect(displayedYes(quotes(58, 61))).toBe(59);
    expect(displayedYes(quotes(50, 60))).toBe(55); // spread exactly 10¢ still counts
  });

  it("is null for a wide, one-sided or missing book", () => {
    expect(MAX_SPREAD_CENTS).toBe(10);
    expect(displayedYes(quotes(50, 61))).toBeNull();
    expect(displayedYes(quotes(58, null))).toBeNull();
    expect(displayedYes(quotes(null, 61))).toBeNull();
    expect(displayedYes(null)).toBeNull();
    expect(displayedYes(undefined)).toBeNull();
  });
});

describe("distributionPoints (M3-03 AC3)", () => {
  const [a190, a170, a180] = ladder();

  it("is the ladder's YES cents in ascending strike order, with fair values alongside", () => {
    const points = distributionPoints(
      [a190, a170, a180] as never,
      {
        [a170?.address ?? ""]: quotes(70, 72),
        [a180?.address ?? ""]: quotes(55, 57),
        [a190?.address ?? ""]: quotes(30, 33),
      },
      { [a180?.address ?? ""]: 56 },
    );
    expect(points.map((p) => [Number(p.strikeCents) / 100, p.yesCents, p.fairCents])).toEqual([
      [170, 71, null],
      [180, 56, 56],
      [190, 31, null],
    ]);
  });

  it("leaves an unreadable book as null rather than a number", () => {
    const points = distributionPoints([a180] as never, {}, {});
    expect(points[0]).toMatchObject({ yesCents: null, fairCents: null });
  });
});

describe("violations (M3-03 AC3: shown, not hidden)", () => {
  const p = (strike: number, yes: number | null) => ({
    market: `m${strike}`,
    strikeCents: BigInt(strike * 100),
    yesCents: yes,
    fairCents: null,
  });

  it("is empty for a ladder that never rises with the strike", () => {
    expect(violations([p(170, 71), p(180, 56), p(190, 31)])).toEqual([]);
    expect(violations([p(170, 50), p(180, 50)])).toEqual([]);
  });

  it("reports every pair where YES rises with the strike", () => {
    expect(violations([p(170, 40), p(180, 56), p(190, 31), p(200, 35)])).toEqual([
      {
        lowerStrikeCents: 17_000n,
        lowerYesCents: 40,
        higherStrikeCents: 18_000n,
        higherYesCents: 56,
      },
      {
        lowerStrikeCents: 19_000n,
        lowerYesCents: 31,
        higherStrikeCents: 20_000n,
        higherYesCents: 35,
      },
    ]);
  });

  it("compares across a strike with no price", () => {
    expect(violations([p(170, 40), p(180, null), p(190, 45)])).toHaveLength(1);
  });
});

const isNonIncreasing = (xs: readonly number[]): boolean =>
  xs.every((x, i) => i === 0 || x <= (xs[i - 1] ?? Number.POSITIVE_INFINITY));

describe("monotoneSurvival (P0-FV: monotone correction for the buckets)", () => {
  it("leaves a sane ladder unchanged", () => {
    expect(monotoneSurvival([71, 56, 31])).toEqual([71, 56, 31]);
    expect(monotoneSurvival([50, 50])).toEqual([50, 50]);
    expect(monotoneSurvival([])).toEqual([]);
  });

  it("pools a violating pair to its average (rounded half up)", () => {
    expect(monotoneSurvival([40, 56])).toEqual([48, 48]);
    expect(monotoneSurvival([40, 57])).toEqual([49, 49]); // 48.5 → 49
    expect(monotoneSurvival([70, 31, 35, 10])).toEqual([70, 33, 33, 10]);
    // A pooled block that then violates the one before it pools again: 170 / 3 = 56.67.
    expect(monotoneSurvival([50, 40, 80])).toEqual([57, 57, 57]);
  });

  it("clamps to 0..100", () => {
    expect(monotoneSurvival([120, -5])).toEqual([100, 0]);
  });

  it("is integer, 0..100, non-increasing, idempotent and keeps the mass within rounding (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -20, max: 120 }), { maxLength: 12 }), (raw) => {
        const out = monotoneSurvival(raw);
        expect(out).toHaveLength(raw.length);
        expect(out.every((x) => Number.isInteger(x) && x >= 0 && x <= 100)).toBe(true);
        expect(isNonIncreasing(out)).toBe(true);
        expect(monotoneSurvival(out)).toEqual(out);
        const clamped = raw.map((x) => Math.min(100, Math.max(0, x)));
        const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
        expect(2 * Math.abs(sum(out) - sum(clamped))).toBeLessThanOrEqual(raw.length);
        if (isNonIncreasing(clamped)) expect(out).toEqual(clamped);
      }),
    );
  });
});

describe("bucketProbabilities (P0-FV: P(S ≥ Kᵢ) − P(S ≥ Kᵢ₊₁))", () => {
  const K = [17_000n, 18_000n, 19_000n];

  it("gives the tails and the adjacent differences", () => {
    expect(bucketProbabilities(K, [71, 56, 31])).toEqual([
      { lowerStrikeCents: null, upperStrikeCents: 17_000n, percent: 29 },
      { lowerStrikeCents: 17_000n, upperStrikeCents: 18_000n, percent: 15 },
      { lowerStrikeCents: 18_000n, upperStrikeCents: 19_000n, percent: 25 },
      { lowerStrikeCents: 19_000n, upperStrikeCents: null, percent: 31 },
    ]);
  });

  it("corrects a violating ladder so no bucket is negative", () => {
    expect(bucketProbabilities(K.slice(0, 2), [40, 56]).map((b) => b.percent)).toEqual([52, 0, 48]);
  });

  it("leaves a bucket next to an unpriced strike empty instead of guessing", () => {
    expect(bucketProbabilities(K, [71, null, 31]).map((b) => b.percent)).toEqual([
      29,
      null,
      null,
      31,
    ]);
    expect(bucketProbabilities(K, [null, null, null]).map((b) => b.percent)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(bucketProbabilities([], [])).toEqual([]);
  });

  it("sums to exactly 100 with every bucket 0..100 when every strike is priced (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 12 }),
        (p) => {
          const strikes = p.map((_, i) => BigInt((i + 1) * 1_000));
          const buckets = bucketProbabilities(strikes, p);
          expect(buckets).toHaveLength(p.length + 1);
          const values = buckets.map((b) => b.percent);
          expect(values.every((v) => v !== null && Number.isInteger(v) && v >= 0 && v <= 100)).toBe(
            true,
          );
          expect(values.reduce<number>((a, b) => a + (b ?? 0), 0)).toBe(100);
          // A ladder that already never rises gives exactly the raw differences.
          if (isNonIncreasing(p)) {
            expect(values.slice(1, -1)).toEqual(p.slice(0, -1).map((x, i) => x - (p[i + 1] ?? 0)));
          }
        },
      ),
    );
  });

  it("with gaps: empty exactly when an edge is unpriced, the rest within 100 (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }), {
          minLength: 1,
          maxLength: 12,
        }),
        (p) => {
          const strikes = p.map((_, i) => BigInt((i + 1) * 1_000));
          const buckets = bucketProbabilities(strikes, p);
          buckets.forEach((bucket, i) => {
            const edges = i === 0 ? [p[0]] : i === p.length ? [p[i - 1]] : [p[i - 1], p[i]];
            expect(bucket.percent === null).toBe(edges.some((e) => e === null));
            if (bucket.percent !== null) expect(bucket.percent).toBeGreaterThanOrEqual(0);
          });
          expect(buckets.reduce((a, b) => a + (b.percent ?? 0), 0)).toBeLessThanOrEqual(100);
        },
      ),
    );
  });
});

describe("distributionBuckets (market bars with the fair-value curve)", () => {
  const p = (strike: number, yes: number | null, fair: number | null) => ({
    market: `m${strike}`,
    strikeCents: BigInt(strike * 100),
    yesCents: yes,
    fairCents: fair,
  });

  it("puts the market's and the fair value's bucket side by side for the same ranges", () => {
    expect(distributionBuckets([p(170, 71, 70), p(180, 56, 58), p(190, 31, null)])).toEqual([
      { lowerStrikeCents: null, upperStrikeCents: 17_000n, marketPercent: 29, fairPercent: 30 },
      { lowerStrikeCents: 17_000n, upperStrikeCents: 18_000n, marketPercent: 15, fairPercent: 12 },
      {
        lowerStrikeCents: 18_000n,
        upperStrikeCents: 19_000n,
        marketPercent: 25,
        fairPercent: null,
      },
      { lowerStrikeCents: 19_000n, upperStrikeCents: null, marketPercent: 31, fairPercent: null },
    ]);
  });
});

describe("fairStaleness and stale points (P0-FV: shown, flagged)", () => {
  const [a190, a170, a180] = ladder();
  const addr = (m: { readonly address: string } | undefined): string => m?.address ?? "";

  it("flags a value marked stale, an old one, and every value after a failed refresh", () => {
    const old = new Date((NOW - 30) * 1000).toISOString();
    const byMarket = {
      [addr(a170)]: fair({ market: addr(a170) }),
      [addr(a180)]: fair({ market: addr(a180), stale: true }),
      [addr(a190)]: fair({ market: addr(a190), as_of: old }),
    };
    const s = fairStaleness(byMarket, false, NOW);
    expect(s[addr(a170)]).toEqual({ stale: false, asOfSecs: NOW - 2 });
    expect(s[addr(a180)]?.stale).toBe(true);
    expect(s[addr(a190)]).toEqual({ stale: true, asOfSecs: NOW - 30 });
    expect(Object.values(fairStaleness(byMarket, true, NOW)).every((v) => v.stale)).toBe(true);
  });

  it("carries the flag and as_of onto the points, and leaves a missing value unflagged", () => {
    const points = distributionPoints(
      [a190, a170, a180] as never,
      {},
      { [addr(a170)]: 70 },
      { [addr(a170)]: { stale: true, asOfSecs: NOW - 45 } },
    );
    expect(points.map((pt) => [pt.fairCents, pt.fairStale, pt.fairAsOfSecs])).toEqual([
      [70, true, NOW - 45],
      [null, false, null],
      [null, false, null],
    ]);
  });
});
