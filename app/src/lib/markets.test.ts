import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { formatStrike, formatTradingDate, groupByTicker, isSessionMarket, marketStatus } from "./markets";
import { market } from "@/test-utils";

/** Unix seconds of an instant given in UTC. */
const utc = (iso: string) => Math.floor(Date.parse(iso) / 1000);

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
  it("returns true for a market closing at the regular session close (16:00 ET)", () => {
    // October 8, 2026 at 16:00 EDT = 20:00 UTC
    const sessionMarket = market({
      tradingDate: 20261008,
      closeTs: BigInt(utc("2026-10-08T20:00:00Z")),
    });
    expect(isSessionMarket(sessionMarket)).toBe(true);
  });

  it("returns true for a market closing at an early-close session (13:00 ET)", () => {
    // November 27, 2026 (day after Thanksgiving) at 13:00 EST = 18:00 UTC
    const earlyCloseMarket = market({
      tradingDate: 20261127,
      closeTs: BigInt(utc("2026-11-27T18:00:00Z")),
    });
    expect(isSessionMarket(earlyCloseMarket)).toBe(true);
  });

  it("returns false for a test market (--close-in-secs) with a non-session close time", () => {
    // October 8, 2026 at 15:00 ET (not the session close)
    const testMarket = market({
      tradingDate: 20261008,
      closeTs: BigInt(utc("2026-10-08T19:00:00Z")),
    });
    expect(isSessionMarket(testMarket)).toBe(false);

    // Another test market: 20:12 ET
    const testMarket2 = market({
      tradingDate: 20261008,
      closeTs: BigInt(utc("2026-10-09T00:12:00Z")),
    });
    expect(isSessionMarket(testMarket2)).toBe(false);
  });

  it("returns false for a market on a weekend", () => {
    // October 10, 2026 is a Saturday (no session)
    const weekendMarket = market({
      tradingDate: 20261010,
      closeTs: BigInt(utc("2026-10-10T20:00:00Z")),
    });
    expect(isSessionMarket(weekendMarket)).toBe(false);
  });

  it("returns false for a market on an NYSE holiday", () => {
    // January 1, 2026 is New Year's Day
    const holidayMarket = market({
      tradingDate: 20260101,
      closeTs: BigInt(utc("2026-01-01T21:00:00Z")),
    });
    expect(isSessionMarket(holidayMarket)).toBe(false);
  });

  it("returns false for a market with a trading date outside supported years", () => {
    // 2025 is not in SUPPORTED_YEARS
    const unsupportedMarket = market({
      tradingDate: 20251008,
      closeTs: BigInt(utc("2025-10-08T20:00:00Z")),
    });
    expect(isSessionMarket(unsupportedMarket)).toBe(false);
  });
});
