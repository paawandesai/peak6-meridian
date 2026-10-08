import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { formatStrike, formatTradingDate, groupByTicker, marketStatus } from "./markets";
import { market } from "@/test-utils";

describe("marketStatus", () => {
  it("is Open before close, Closed at/after close, Settled once settled", () => {
    const m = market({ closeTs: 1_000n });
    expect(marketStatus(m, 999)).toBe("Open");
    expect(marketStatus(m, 1_000)).toBe("Closed");
    expect(marketStatus({ ...m, settled: true }, 5_000)).toBe("Settled");
  });
});

describe("groupByTicker", () => {
  it("groups alphabetically, newest date first, ascending strike", () => {
    const groups = groupByTicker([
      market({ address: "a", ticker: "NVDA", strikeCents: 15_000n }),
      market({ address: "b", ticker: "AAPL", strikeCents: 23_000n }),
      market({ address: "c", ticker: "AAPL", strikeCents: 22_000n }),
      market({ address: "d", ticker: "AAPL", strikeCents: 21_000n, tradingDate: 20260106 }),
    ]);
    expect(groups.map((g) => g.ticker)).toEqual(["AAPL", "NVDA"]);
    expect(groups[0]?.markets.map((m) => m.address)).toEqual(["d", "c", "b"]);
  });

  it("keeps every market exactly once (property)", () => {
    const row = fc.record({
      address: fc.uuid(),
      ticker: fc.constantFrom("AAPL", "MSFT", "TSLA"),
      tradingDate: fc.integer({ min: 20260101, max: 20261231 }),
      strikeCents: fc.integer({ min: 1, max: 100_000 }).map((n) => BigInt(n) * 1_000n),
    });
    fc.assert(
      fc.property(fc.array(row), (rows) => {
        const groups = groupByTicker(rows.map((r) => market(r)));
        const addresses = groups.flatMap((g) => g.markets.map((m) => m.address)).sort();
        expect(addresses).toEqual(rows.map((r) => r.address).sort());
        for (const g of groups) expect(g.markets.every((m) => m.ticker === g.ticker)).toBe(true);
      }),
    );
  });
});

describe("formatters", () => {
  it("formats strikes in whole dollars and dates as ISO", () => {
    expect(formatStrike(68_000n)).toBe("$680");
    expect(formatStrike(1_234_000n)).toBe("$12,340");
    expect(formatTradingDate(20260105)).toBe("2026-01-05");
  });

  it("rejects a strike that is not whole dollars", () => {
    expect(() => formatStrike(68_050n)).toThrow();
  });
});
