import { isTradingDay } from "@meridian/client";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  demoBadgeText,
  demoBannerLines,
  findDemoSession,
  formatCalendarDate,
  formatEtDateTime,
  isDemoMarket,
  isDemoTradingDate,
  isValidYyyymmdd,
  parseDemoRegistry,
  type DemoRegistry,
} from "./demo-session";
import { partitionMarkets } from "./markets";
import { market } from "@/test-utils";

const utc = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** Sun Oct 11, 2026 8:00 PM EDT = 00:00 UTC Oct 12. */
const DEMO_CLOSE = utc("2026-10-12T00:00:00Z");

const SESSION = {
  tradingDate: 20261011,
  asOf: 20261009,
  closeTs: DEMO_CLOSE,
  createdAt: "2026-10-10T15:00:00Z",
  tickers: ["AAPL", "NVDA"],
  strikesByTicker: { AAPL: [22_000, 23_000], NVDA: [18_000] },
  asOfCloseCentsByTicker: { AAPL: 22_512, NVDA: 18_034 },
};
const REGISTRY: DemoRegistry = parseDemoRegistry(JSON.stringify([SESSION]));

/** Every calendar date of 2026 as `YYYYMMDD`. */
const date2026 = fc.integer({ min: 0, max: 364 }).map((offset) => {
  const d = new Date(Date.UTC(2026, 0, 1) + offset * 86_400_000);
  return d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
});
const iso = (n: number) =>
  `${String(n).slice(0, 4)}-${String(n).slice(4, 6)}-${String(n).slice(6)}`;

describe("isDemoTradingDate", () => {
  it("is true on weekends", () => {
    expect(isDemoTradingDate(20261010)).toBe(true); // Sat
    expect(isDemoTradingDate(20261011)).toBe(true); // Sun
  });

  it("is true on NYSE holidays", () => {
    expect(isDemoTradingDate(20261126)).toBe(true); // Thanksgiving
    expect(isDemoTradingDate(20261225)).toBe(true); // Christmas
  });

  it("is false on trading days, including early-close days", () => {
    expect(isDemoTradingDate(20261009)).toBe(false); // Fri
    expect(isDemoTradingDate(20261127)).toBe(false); // early close 13:00
  });

  it("is false for something that is not a date", () => {
    expect(isDemoTradingDate(20260230)).toBe(false);
    expect(isDemoTradingDate(0)).toBe(false);
    expect(isDemoTradingDate(2026101)).toBe(false);
  });

  it("falls back to the weekend test outside the holiday tables", () => {
    expect(isDemoTradingDate(20300105)).toBe(true); // Sat Jan 5, 2030
    expect(isDemoTradingDate(20300107)).toBe(false); // Mon
  });

  it("matches 'not an NYSE trading day' for every date of 2026", () => {
    fc.assert(
      fc.property(date2026, (date) => {
        expect(isDemoTradingDate(date)).toBe(!isTradingDay(iso(date)));
      }),
      { numRuns: 400 },
    );
  });

  it("always classifies Saturdays and Sundays as demo, in any year", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40_000 }), (offset) => {
        const d = new Date(Date.UTC(2000, 0, 1) + offset * 86_400_000);
        const value = d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
        const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
        if (weekend) expect(isDemoTradingDate(value)).toBe(true);
      }),
    );
  });
});

describe("isValidYyyymmdd", () => {
  it("accepts real dates and rejects impossible ones", () => {
    expect(isValidYyyymmdd(20240229)).toBe(true);
    expect(isValidYyyymmdd(20260229)).toBe(false);
    expect(isValidYyyymmdd(20261301)).toBe(false);
    expect(isValidYyyymmdd(20261000)).toBe(false);
    expect(isValidYyyymmdd(1.5)).toBe(false);
  });
});

describe("parseDemoRegistry", () => {
  it("accepts a bare list and normalises dates and close times", () => {
    const registry = parseDemoRegistry(
      JSON.stringify([
        { ...SESSION, tradingDate: "2026-10-11", asOf: "20261009", closeTs: "1792" },
      ]),
    );
    expect(registry.error).toBeNull();
    expect(registry.sessions[0]).toMatchObject({
      tradingDate: 20261011,
      asOf: 20261009,
      closeTs: 1792,
    });
  });

  it("accepts { sessions: [...] }", () => {
    const registry = parseDemoRegistry(JSON.stringify({ sessions: [SESSION] }));
    expect(registry.sessions).toHaveLength(1);
  });

  it("treats missing or empty text as an empty registry", () => {
    expect(parseDemoRegistry(undefined)).toEqual({ sessions: [], error: null });
    expect(parseDemoRegistry("  ")).toEqual({ sessions: [], error: null });
  });

  it("reports text that is not JSON", () => {
    const registry = parseDemoRegistry("{not json");
    expect(registry.sessions).toEqual([]);
    expect(registry.error).toMatch(/not JSON/);
  });

  it("reports a wrong shape", () => {
    const registry = parseDemoRegistry(JSON.stringify([{ ...SESSION, asOf: 20260230 }]));
    expect(registry.sessions).toEqual([]);
    expect(registry.error).toMatch(/invalid/);
    expect(parseDemoRegistry(JSON.stringify({ nope: 1 })).error).toMatch(/invalid/);
  });

  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (text) => {
        const registry = parseDemoRegistry(text);
        expect(Array.isArray(registry.sessions)).toBe(true);
      }),
    );
  });
});

describe("findDemoSession", () => {
  it("picks the newest entry for the date", () => {
    const registry = parseDemoRegistry(
      JSON.stringify([
        { ...SESSION, asOf: 20261008, createdAt: "2026-10-10T10:00:00Z" },
        { ...SESSION, asOf: 20261009, createdAt: "2026-10-10T15:00:00Z" },
      ]),
    );
    expect(findDemoSession(registry, 20261011)?.asOf).toBe(20261009);
    expect(findDemoSession(registry, 20261010)).toBeUndefined();
  });
});

describe("ET formatting", () => {
  it("formats a calendar date with its weekday", () => {
    expect(formatCalendarDate(20261009)).toBe("Fri Oct 9, 2026");
    expect(formatCalendarDate(20261231)).toBe("Thu Dec 31, 2026");
  });

  it("formats in ET during daylight time (EDT, UTC−4)", () => {
    expect(formatEtDateTime(DEMO_CLOSE)).toBe("Sun Oct 11, 8:00 PM ET");
  });

  it("formats in ET during standard time (EST, UTC−5)", () => {
    expect(formatEtDateTime(utc("2026-11-09T01:00:00Z"))).toBe("Sun Nov 8, 8:00 PM ET");
    expect(formatEtDateTime(utc("2026-12-14T15:30:00Z"), true)).toBe(
      "Mon Dec 14, 2026 10:30 AM ET",
    );
  });

  it("handles the night DST ends (Nov 1, 2026)", () => {
    // 05:30 UTC is 01:30 EDT, 06:30 UTC is 01:30 EST: same wall time, both ET.
    expect(formatEtDateTime(utc("2026-11-01T05:30:00Z"))).toBe("Sun Nov 1, 1:30 AM ET");
    expect(formatEtDateTime(utc("2026-11-01T06:30:00Z"))).toBe("Sun Nov 1, 1:30 AM ET");
    expect(formatEtDateTime(utc("2026-11-02T01:00:00Z"))).toBe("Sun Nov 1, 8:00 PM ET");
  });
});

describe("demoBannerLines", () => {
  const demo = (overrides = {}) =>
    market({ tradingDate: 20261011, closeTs: BigInt(DEMO_CLOSE), ...overrides });
  const now = utc("2026-10-11T15:00:00Z");

  it("produces the exact banner text for a registered session", () => {
    expect(demoBannerLines([demo()], REGISTRY, now)).toEqual([
      {
        tradingDate: 20261011,
        text: "DEMO SESSION · simulates Fri Oct 9, 2026 · trading closes Sun Oct 11, 8:00 PM ET · devnet, no real funds",
      },
    ]);
  });

  it("says 'not a real market day' for a demo market missing from the registry", () => {
    const [line] = demoBannerLines([demo({ tradingDate: 20261010 })], REGISTRY, now);
    expect(line?.text).toBe(
      "DEMO · not a real market day (Sat Oct 10, 2026) · trading closes Sun Oct 11, 8:00 PM ET · devnet, no real funds",
    );
  });

  it("uses the on-chain close_ts, not the registry's copy", () => {
    const registry = parseDemoRegistry(JSON.stringify([{ ...SESSION, closeTs: 1 }]));
    const [line] = demoBannerLines(
      [demo({ closeTs: BigInt(utc("2026-10-11T22:30:00Z")) })],
      registry,
      now,
    );
    expect(line?.text).toContain("trading closes Sun Oct 11, 6:30 PM ET");
  });

  it("says 'trading closed' once the close has passed but settlement has not", () => {
    const [line] = demoBannerLines([demo()], REGISTRY, DEMO_CLOSE + 60);
    expect(line?.text).toContain("trading closed Sun Oct 11, 8:00 PM ET");
  });

  it("drops settled demo markets, so a finished session leaves no banner", () => {
    expect(demoBannerLines([demo({ settled: true })], REGISTRY, now)).toEqual([]);
  });

  it("never produces a line for real trading-day markets", () => {
    fc.assert(
      fc.property(date2026, fc.integer({ min: 0, max: 2_000_000_000 }), (date, close) => {
        fc.pre(isTradingDay(iso(date)));
        const rows = [market({ tradingDate: date, closeTs: BigInt(close) })];
        expect(demoBannerLines(rows, REGISTRY, now)).toEqual([]);
      }),
    );
  });
});

describe("demo badge and listing", () => {
  it("badges a registered demo market with its simulated date", () => {
    expect(demoBadgeText(20261011, REGISTRY)).toBe("DEMO · simulates Fri Oct 9, 2026");
    expect(demoBadgeText(20261010, REGISTRY)).toBe("DEMO · not a real market day");
  });

  it("lists demo markets with session markets, and keeps trading-day test markets apart", () => {
    const real = market({
      address: "real",
      tradingDate: 20261009,
      closeTs: BigInt(utc("2026-10-09T20:00:00Z")),
    });
    const demo = market({ address: "demo", tradingDate: 20261011, closeTs: BigInt(DEMO_CLOSE) });
    const test = market({ address: "test", tradingDate: 20261009, closeTs: 123n });
    const { session, test: tests } = partitionMarkets([real, demo, test]);
    expect(session.map((m) => m.address)).toEqual(["real", "demo"]);
    expect(tests.map((m) => m.address)).toEqual(["test"]);
    expect(isDemoMarket(real)).toBe(false);
    expect(isDemoMarket(demo)).toBe(true);
  });
});
