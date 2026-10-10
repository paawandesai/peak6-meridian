import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isTradingDay } from "./calendar";
import {
  type DemoSession,
  demoSessionSchema,
  demoSessionsSchema,
  findDemoSession,
  isDemoTradingDate,
  toIsoTradingDate,
} from "./demo-sessions";
import * as index from "./index";

const SESSION: DemoSession = {
  tradingDate: "2026-10-11",
  asOf: "2026-10-09",
  closeTs: 1_791_763_200,
  createdAt: "2026-10-10T18:00:00.000Z",
  tickers: ["AAPL", "MSFT"],
  strikesByTicker: { AAPL: [31_000, 32_000, 33_000], MSFT: [48_000, 49_000] },
  asOfCloseCentsByTicker: { AAPL: 33_606 },
  prevCloseDate: "2026-10-08",
  prevCloseCentsByTicker: { AAPL: 34_058, MSFT: 52_241 },
};

describe("demoSessionsSchema", () => {
  it("round-trips a registry through JSON unchanged", () => {
    const registry = { sessions: [SESSION] };
    const parsed = demoSessionsSchema.parse(JSON.parse(JSON.stringify(registry)));
    expect(parsed).toEqual(registry);
  });

  it("accepts an empty registry and a session without the optional audit fields", () => {
    expect(demoSessionsSchema.parse({ sessions: [] })).toEqual({ sessions: [] });
    const { prevCloseDate, prevCloseCentsByTicker, ...minimal } = SESSION;
    expect(prevCloseDate).toBeDefined();
    expect(prevCloseCentsByTicker).toBeDefined();
    expect(demoSessionSchema.parse(minimal)).toEqual(minimal);
  });

  it("refuses duplicate trading dates", () => {
    const result = demoSessionsSchema.safeParse({ sessions: [SESSION, SESSION] });
    expect(result.success).toBe(false);
  });

  it.each([
    ["a float price", { asOfCloseCentsByTicker: { AAPL: 336.05 } }],
    ["a zero strike", { strikesByTicker: { AAPL: [0] } }],
    ["an impossible date", { tradingDate: "2026-02-30" }],
    ["a compact date", { asOf: "20261009" }],
    ["a lower-case ticker", { tickers: ["aapl"] }],
    ["no tickers", { tickers: [] }],
    ["a non-ISO createdAt", { createdAt: "Sat Oct 10" }],
    ["a float closeTs", { closeTs: 1.5 }],
  ])("refuses %s", (_name, patch) => {
    expect(demoSessionSchema.safeParse({ ...SESSION, ...patch }).success).toBe(false);
  });

  it("is exported from the package index", () => {
    expect(index.demoSessionsSchema).toBe(demoSessionsSchema);
    expect(index.isDemoTradingDate).toBe(isDemoTradingDate);
  });
});

describe("toIsoTradingDate", () => {
  it("accepts the on-chain number, the compact string and the ISO string", () => {
    expect(toIsoTradingDate(20_261_011)).toBe("2026-10-11");
    expect(toIsoTradingDate("20261011")).toBe("2026-10-11");
    expect(toIsoTradingDate("2026-10-11")).toBe("2026-10-11");
  });

  it("refuses malformed and impossible dates", () => {
    for (const bad of [20_261_301, "2026-13-01", "2026101", "", "tomorrow", 20_260_230]) {
      expect(toIsoTradingDate(bad)).toBeNull();
    }
  });
});

describe("isDemoTradingDate", () => {
  it("is true on weekends and NYSE holidays", () => {
    expect(isDemoTradingDate(20_261_010)).toBe(true); // Saturday
    expect(isDemoTradingDate(20_261_011)).toBe(true); // Sunday
    expect(isDemoTradingDate("2026-11-26")).toBe(true); // Thanksgiving
    expect(isDemoTradingDate("20260907")).toBe(true); // Labor Day
  });

  it("is false on trading days, including early closes", () => {
    expect(isDemoTradingDate(20_261_009)).toBe(false);
    expect(isDemoTradingDate(20_261_012)).toBe(false);
    expect(isDemoTradingDate("2026-11-27")).toBe(false); // early close, still a session
  });

  it("is false for malformed dates and for weekdays outside the holiday tables", () => {
    expect(isDemoTradingDate("garbage")).toBe(false);
    expect(isDemoTradingDate(20_271_013)).toBe(false); // a 2027 Wednesday: unknown, not demo
    expect(isDemoTradingDate(20_271_016)).toBe(true); // a 2027 Saturday is never a session
  });

  it("is exactly the complement of the calendar over 2026", () => {
    const day = fc.integer({ min: 0, max: 364 }).map((offset) => {
      const date = new Date(Date.UTC(2026, 0, 1 + offset));
      return date.toISOString().slice(0, 10);
    });
    fc.assert(
      fc.property(day, (iso) => {
        expect(isDemoTradingDate(iso)).toBe(!isTradingDay(iso));
        expect(isDemoTradingDate(Number(iso.replaceAll("-", "")))).toBe(!isTradingDay(iso));
      }),
    );
  });
});

describe("findDemoSession", () => {
  const registry = { sessions: [SESSION] };

  it("finds the session by any date form", () => {
    expect(findDemoSession(registry, 20_261_011)).toBe(SESSION);
    expect(findDemoSession(registry, "2026-10-11")).toBe(SESSION);
  });

  it("returns undefined for an unknown or malformed date", () => {
    expect(findDemoSession(registry, 20_261_010)).toBeUndefined();
    expect(findDemoSession(registry, "nope")).toBeUndefined();
  });
});
