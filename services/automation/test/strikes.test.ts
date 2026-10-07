import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { computeStrikes, MAX_PREV_CLOSE_CENTS } from "../src/strikes";

const dollars = (cents: readonly number[]): number[] => cents.map((c) => c / 100);

describe("computeStrikes: PRD examples (AC1)", () => {
  it("META 680 → 620..740", () => {
    expect(dollars(computeStrikes(68_000))).toEqual([620, 640, 660, 680, 700, 720, 740]);
  });

  it("AAPL 230 → 210..250 (5 after dedup)", () => {
    expect(dollars(computeStrikes(23_000))).toEqual([210, 220, 230, 240, 250]);
  });
});

describe("computeStrikes: rounding", () => {
  it("rounds exact halves up", () => {
    // P = $2,500: −9% = 2,275, −3% = 2,425, +3% = 2,575, +9% = 2,725 are all exact halves.
    expect(dollars(computeStrikes(250_000))).toEqual([2280, 2350, 2430, 2500, 2580, 2650, 2730]);
  });

  it("rounds a hair below a half down, using exact cents", () => {
    // P = $2,499.99: −3% = 2,424.9903 → 2,420; +3% = 2,574.9897 → 2,570.
    expect(dollars(computeStrikes(249_999))).toEqual([2270, 2350, 2420, 2500, 2570, 2650, 2720]);
  });

  it("drops strikes that round to 0 for tiny prices", () => {
    expect(computeStrikes(100)).toEqual([]);
    expect(computeStrikes(500)).toEqual([1_000]);
  });

  it.each([0, -100, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_PREV_CLOSE_CENTS + 1])(
    "rejects invalid previous close %s",
    (bad) => {
      expect(() => computeStrikes(bad)).toThrow(RangeError);
    },
  );

  it("accepts the largest supported close", () => {
    const strikes = computeStrikes(MAX_PREV_CLOSE_CENTS);
    expect(strikes.every((s) => Number.isSafeInteger(s))).toBe(true);
  });
});

describe("computeStrikes: properties (AC2)", () => {
  const prevClose = fc.integer({ min: 1, max: 100_000_000 }); // $0.01 .. $1,000,000

  it("multiples of $10, > 0, sorted, unique, at most 7, within ±9% + $5 of P", () => {
    fc.assert(
      fc.property(prevClose, (p) => {
        const strikes = computeStrikes(p);
        expect(strikes.length).toBeLessThanOrEqual(7);
        expect(new Set(strikes).size).toBe(strikes.length);
        strikes.forEach((s, i) => {
          expect(Number.isSafeInteger(s)).toBe(true);
          expect(s % 1_000).toBe(0);
          expect(s).toBeGreaterThan(0);
          if (i > 0) {
            expect(s).toBeGreaterThan(strikes[i - 1] ?? Number.NaN);
          }
          // |s − P| ≤ 0.09·P + 500 cents, compared exactly: 100·|s − P| ≤ 9·P + 50,000.
          expect(100 * Math.abs(s - p)).toBeLessThanOrEqual(9 * p + 50_000);
        });
      }),
    );
  });

  it("matches an independent integer reference of the domain.md formula", () => {
    // raw in hundredths of a cent = P·(100 + k); $10 = 100,000 of those; halves up.
    const reference = (p: number): number[] =>
      [
        ...new Set(
          [-9, -6, -3, 0, 3, 6, 9].map(
            (k) => Math.floor((p * (100 + k) + 50_000) / 100_000) * 1_000,
          ),
        ),
      ]
        .filter((s) => s > 0)
        .sort((a, b) => a - b);
    fc.assert(
      fc.property(prevClose, (p) => {
        expect(computeStrikes(p)).toEqual(reference(p));
      }),
    );
  });

  it("always contains the at-the-money strike when P ≥ $5", () => {
    fc.assert(
      fc.property(fc.integer({ min: 500, max: 100_000_000 }), (p) => {
        const atm = Math.floor((2 * p + 1_000) / 2_000) * 1_000;
        expect(computeStrikes(p)).toContain(atm);
      }),
    );
  });

  it("is monotone in P: a higher close never lowers the lowest or highest strike", () => {
    fc.assert(
      fc.property(fc.integer({ min: 500, max: 10_000_000 }), fc.nat(1_000_000), (p, d) => {
        const lo = computeStrikes(p);
        const hi = computeStrikes(p + d);
        expect(hi[0] ?? 0).toBeGreaterThanOrEqual(lo[0] ?? 0);
        expect(hi.at(-1) ?? 0).toBeGreaterThanOrEqual(lo.at(-1) ?? 0);
      }),
    );
  });
});
