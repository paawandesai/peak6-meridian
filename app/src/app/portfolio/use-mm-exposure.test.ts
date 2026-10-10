/**
 * P1-5: Tests for useMMExposure hook.
 */
import { describe, it, expect } from "vitest";
import { useMMExposure } from "./use-mm-exposure";
import type { PortfolioModel, MmStrike } from "./model";
import type { MarketRow } from "@/lib/markets";

// Minimal MarketRow for testing
function makeMarket(address: string, strikeCents: bigint): MarketRow {
  return {
    address,
    ticker: "TEST",
    tradingDate: 20261010,
    strikeCents,
    closeTs: 1728518400n,
    settled: false,
    outcome: "None",
    settlePriceScaled: 0n,
    pairsOutstanding: 0n,
    settledAt: 0n,
  };
}

function makeModel(
  strikes: MmStrike[],
  openOrders: number,
  unsettledUsdc: bigint,
): PortfolioModel {
  return {
    rows: [],
    resting: [],
    totals: {
      usdc: 0n,
      redeemable: 0n,
      unrealized: 0n,
      realized: 0n,
    },
    mm: {
      strikes,
      openOrders,
      unsettledUsdc,
      unsettledYes: 0n,
      withdrawable: [],
    },
    redeemable: [],
    incompleteHistory: false,
  };
}

describe("useMMExposure", () => {
  it("returns null when model is null", () => {
    expect(useMMExposure(null)).toBeNull();
  });

  it("returns null when no open orders", () => {
    const model = makeModel([], 0, 0n);
    expect(useMMExposure(model)).toBeNull();
  });

  it("returns data when there are open orders", () => {
    const market1 = makeMarket("market1", 5000n);
    const strikes: MmStrike[] = [
      { market: market1, net: 10n, resting: 2 },
    ];
    const model = makeModel(strikes, 2, 100_000_000n);

    const result = useMMExposure(model);

    expect(result).toEqual({
      strikeExposures: [
        {
          strikeCents: 5000n,
          netContracts: 10,
          marketAddress: "market1",
        },
      ],
      openOrdersCount: 2,
      unsettledBalanceBase: 100_000_000n,
    });
  });

  it("filters out strikes with zero net exposure", () => {
    const market1 = makeMarket("market1", 5000n);
    const market2 = makeMarket("market2", 6000n);
    const strikes: MmStrike[] = [
      { market: market1, net: 10n, resting: 2 },
      { market: market2, net: 0n, resting: 0 },
    ];
    const model = makeModel(strikes, 2, 0n);

    const result = useMMExposure(model);

    expect(result).not.toBeNull();
    expect(result!.strikeExposures).toHaveLength(1);
    expect(result!.strikeExposures[0]!.marketAddress).toBe("market1");
  });

  it("sorts strikes by strike price ascending", () => {
    const market1 = makeMarket("market1", 7000n);
    const market2 = makeMarket("market2", 5000n);
    const market3 = makeMarket("market3", 6000n);
    const strikes: MmStrike[] = [
      { market: market1, net: 5n, resting: 1 },
      { market: market2, net: -3n, resting: 1 },
      { market: market3, net: 10n, resting: 1 },
    ];
    const model = makeModel(strikes, 3, 0n);

    const result = useMMExposure(model);

    expect(result).not.toBeNull();
    expect(result!.strikeExposures.map((s) => Number(s.strikeCents))).toEqual([
      5000, 6000, 7000,
    ]);
  });

  it("converts negative net exposure correctly", () => {
    const market1 = makeMarket("market1", 5000n);
    const strikes: MmStrike[] = [
      { market: market1, net: -15n, resting: 1 },
    ];
    const model = makeModel(strikes, 1, 0n);

    const result = useMMExposure(model);

    expect(result).not.toBeNull();
    expect(result!.strikeExposures[0]!.netContracts).toBe(-15);
  });

  it("handles multiple strikes with mixed positive/negative exposure", () => {
    const market1 = makeMarket("market1", 5000n);
    const market2 = makeMarket("market2", 6000n);
    const market3 = makeMarket("market3", 7000n);
    const strikes: MmStrike[] = [
      { market: market1, net: 10n, resting: 2 },
      { market: market2, net: -5n, resting: 1 },
      { market: market3, net: 3n, resting: 1 },
    ];
    const model = makeModel(strikes, 4, 250_000_000n);

    const result = useMMExposure(model);

    expect(result).toEqual({
      strikeExposures: [
        { strikeCents: 5000n, netContracts: 10, marketAddress: "market1" },
        { strikeCents: 6000n, netContracts: -5, marketAddress: "market2" },
        { strikeCents: 7000n, netContracts: 3, marketAddress: "market3" },
      ],
      openOrdersCount: 4,
      unsettledBalanceBase: 250_000_000n,
    });
  });

  it("handles zero unsettled balance", () => {
    const market1 = makeMarket("market1", 5000n);
    const strikes: MmStrike[] = [
      { market: market1, net: 1n, resting: 1 },
    ];
    const model = makeModel(strikes, 1, 0n);

    const result = useMMExposure(model);

    expect(result?.unsettledBalanceBase).toBe(0n);
  });

  it("handles large contract counts", () => {
    const market1 = makeMarket("market1", 5000n);
    const strikes: MmStrike[] = [
      { market: market1, net: 1000n, resting: 50 },
    ];
    const model = makeModel(strikes, 50, 1_000_000_000n);

    const result = useMMExposure(model);

    expect(result).not.toBeNull();
    expect(result!.strikeExposures[0]!.netContracts).toBe(1000);
    expect(result!.openOrdersCount).toBe(50);
  });
});
