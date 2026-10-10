import { describe, expect, it } from "vitest";

import { closeSets } from "./ticker-ladder";
import type { MarketRow } from "@/lib/markets";

const row = (strike: number, close: number): MarketRow =>
  ({
    address: `${strike}-${close}`,
    strikeCents: BigInt(strike * 100),
    closeTs: BigInt(close),
  }) as MarketRow;

describe("closeSets", () => {
  it("puts the soonest set that brackets the live price first, the rest after by close", () => {
    const markets = [
      row(210, 100),
      row(250, 100),
      row(330, 200),
      row(340, 200),
      row(300, 300),
      row(350, 300),
    ];
    const { primary, others } = closeSets(markets, 33_606n);
    expect(primary.map((m) => m.closeTs)).toEqual([200n, 200n]);
    expect(primary.map((m) => m.strikeCents)).toEqual([33_000n, 34_000n]);
    expect(others.map((s) => s[0]?.closeTs)).toEqual([100n, 300n]);
  });

  it("falls back to the soonest set without a live price", () => {
    const { primary } = closeSets([row(340, 200), row(330, 100)], null);
    expect(primary[0]?.closeTs).toBe(100n);
  });
});
