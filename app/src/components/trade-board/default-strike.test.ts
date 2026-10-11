import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { defaultStrikeIndex, resolveSelectedStrike } from "./default-strike";

/** Distinct ascending strikes in cents (multiples of $5, like the real ladder). */
const strikesArb = fc
  .uniqueArray(fc.integer({ min: 1, max: 4_000 }), { minLength: 1, maxLength: 12 })
  .map((xs) => [...xs].sort((a, b) => a - b).map((x) => BigInt(x * 500)));

const row = (strikeCents: bigint) => ({ address: `M${strikeCents}`, strikeCents });

describe("defaultStrikeIndex", () => {
  it("picks the strike at or just above the live price", () => {
    const strikes = [17_000n, 17_500n, 18_000n, 18_500n, 19_000n];
    expect(defaultStrikeIndex(strikes, 18_142n)).toBe(3); // $181.42 → $185
    expect(defaultStrikeIndex(strikes, 18_000n)).toBe(2); // exactly at $180 → $180
    expect(defaultStrikeIndex(strikes, 10_000n)).toBe(0); // below the ladder → lowest
    expect(defaultStrikeIndex(strikes, 25_000n)).toBe(4); // above the ladder → highest
  });

  it("uses the middle strike without a live price and -1 for no strikes", () => {
    expect(defaultStrikeIndex([1n, 2n, 3n, 4n], null)).toBe(1);
    expect(defaultStrikeIndex([1n, 2n, 3n], null)).toBe(1);
    expect(defaultStrikeIndex([], 100n)).toBe(-1);
    expect(defaultStrikeIndex([], null)).toBe(-1);
  });

  it("property: the pick is the smallest strike ≥ live, or the highest when none is", () => {
    fc.assert(
      fc.property(strikesArb, fc.integer({ min: 0, max: 2_100_000 }), (strikes, liveNum) => {
        const live = BigInt(liveNum);
        const i = defaultStrikeIndex(strikes, live);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(strikes.length);
        const pick = strikes[i] ?? -1n;
        const anyAbove = strikes.some((s) => s >= live);
        if (anyAbove) {
          expect(pick >= live).toBe(true);
          // Nothing between live and the pick.
          expect(strikes.every((s) => s < live || s >= pick)).toBe(true);
        } else {
          expect(i).toBe(strikes.length - 1);
        }
      }),
    );
  });

  it("property: without a live price the pick is always on the ladder", () => {
    fc.assert(
      fc.property(strikesArb, (strikes) => {
        const i = defaultStrikeIndex(strikes, null);
        expect(strikes[i]).toBeDefined();
      }),
    );
  });
});

describe("resolveSelectedStrike", () => {
  const ladder = [17_000n, 18_000n, 19_000n].map(row);

  it("keeps an address that is on the ladder", () => {
    expect(resolveSelectedStrike(ladder, "M19000", 18_142n)?.address).toBe("M19000");
  });

  it("falls back to the default for no address or an unknown one", () => {
    expect(resolveSelectedStrike(ladder, null, 18_142n)?.address).toBe("M19000");
    expect(resolveSelectedStrike(ladder, "nope", 17_500n)?.address).toBe("M18000");
    expect(resolveSelectedStrike(ladder, "nope", null)?.address).toBe("M18000");
  });

  it("is null for an empty ladder", () => {
    expect(resolveSelectedStrike([], "M18000", 18_000n)).toBeNull();
  });
});
