import { describe, expect, it } from "vitest";
import { type MarketInvariant } from "./route";

/**
 * Minimal tests for /api/status route (P1-6).
 * Full integration tests via Playwright; these verify type contracts only.
 */

describe("MarketInvariant type", () => {
  it("has required fields for status display", () => {
    const mockMarket: MarketInvariant = {
      address: "market1",
      ticker: "AAPL",
      strikeCents: 18000,
      vaultBase: "1000000",
      pairsOutstanding: "1",
      expectedVaultBase: "1000000",
      invariantPass: true,
      closeTs: 1728586800,
      settledAt: 0,
      oracleAsOf: 0,
      createdAt: 0,
      settleSlot: 0,
      outcome: "None",
      settled: false,
    };

    expect(mockMarket.address).toBe("market1");
    expect(mockMarket.outcome).toBe("None");
    expect(mockMarket.settled).toBe(false);
  });
});
