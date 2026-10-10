import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  formatStrike,
  formatTradingDate,
  groupByTicker,
  isSessionMarket,
  marketStatus,
} from "./markets";
import { market } from "@/test-utils";

describe("marketStatus", () => {
  it("is Open before close, Closed at/after close, Settled once settled", () => {
    const m = market({ closeTs: 1_000n });
    // UI-02 AC7 edit: 999 is one second before close, so it is now ClosingSoon (the 15-minute
    // window); Open holds until 15 minutes before. Was: `expect(marketStatus(m, 999)).toBe("Open")`.
    expect(marketStatus(m, 1_000 - 901)).toBe("Open");
    expect(marketStatus(m, 999)).toBe("ClosingSoon");
    expect(marketStatus(m, 1_000)).toBe("Closed");
    expect(marketStatus({ ...m, settled: true }, 5_000)).toBe("Settled");
  });

  it("walks every boundary: Open, ClosingSoon, Closed, Settling, SettlementDelayed", () => {
    const m = market({ closeTs: 10_000n });
    const at = (offset: number) => marketStatus(m, 10_000 + offset);
    expect(at(-901)).toBe("Open");
    expect(at(-900)).toBe("ClosingSoon"); // close - 15 min
    expect(at(-1)).toBe("ClosingSoon");
    expect(at(0)).toBe("Closed");
    expect(at(299)).toBe("Closed");
    expect(at(300)).toBe("Settling"); // close + 5 min
    expect(at(1_199)).toBe("Settling");
    expect(at(1_200)).toBe("SettlementDelayed"); // close + 20 min
    expect(at(86_400)).toBe("SettlementDelayed"); // no upper bound
  });

  it("Settled wins over every time-based state", () => {
    const m = market({ closeTs: 10_000n, settled: true });
    for (const offset of [-5_000, -1, 0, 300, 1_200, 90_000]) {
      expect(marketStatus(m, 10_000 + offset)).toBe("Settled");
    }
  });

  it("is monotonic in time for an unsettled market (property)", () => {
    const order = ["Open", "ClosingSoon", "Closed", "Settling", "SettlementDelayed"];
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200_000 }),
        fc.integer({ min: 0, max: 5_000 }),
        (a, d) => {
          const m = market({ closeTs: 100_000n });
          expect(order.indexOf(marketStatus(m, a))).toBeLessThanOrEqual(
            order.indexOf(marketStatus(m, a + d)),
          );
        },
      ),
    );
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

describe("isSessionMarket (P0-1)", () => {
  it("returns true when closeTs matches the session close", () => {
    // 2026-10-08 is a Thursday (regular session), closes 16:00 ET = 20:00 UTC
    const regularDay = market({ tradingDate: 20261008, closeTs: BigInt(Date.parse("2026-10-08T20:00:00Z") / 1000) });
    expect(isSessionMarket(regularDay)).toBe(true);
  });

  it("returns false when closeTs does not match the session close", () => {
    // 2026-10-08 session close is 20:00 UTC, but this market closes at 19:00 UTC (test market)
    const testMarket = market({ tradingDate: 20261008, closeTs: BigInt(Date.parse("2026-10-08T19:00:00Z") / 1000) });
    expect(isSessionMarket(testMarket)).toBe(false);
  });

  it("returns true for early-close days (session close at 13:00 ET)", () => {
    // 2026-11-27 is day after Thanksgiving (early close at 13:00 ET = 18:00 UTC in EST)
    const earlyClose = market({ tradingDate: 20261127, closeTs: BigInt(Date.parse("2026-11-27T18:00:00Z") / 1000) });
    expect(isSessionMarket(earlyClose)).toBe(true);
  });

  it("returns false for weekend/holiday (no session)", () => {
    // 2026-10-10 is Saturday, no session
    const weekend = market({ tradingDate: 20261010, closeTs: BigInt(Date.parse("2026-10-10T20:00:00Z") / 1000) });
    expect(isSessionMarket(weekend)).toBe(false);
  });
});
