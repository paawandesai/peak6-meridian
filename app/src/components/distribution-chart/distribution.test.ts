import { describe, expect, it } from "vitest";

import { displayedYes, distributionPoints, MAX_SPREAD_CENTS, violations } from "./distribution";
import { ladder, quotes } from "@/components/fair-value/test-support";

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
