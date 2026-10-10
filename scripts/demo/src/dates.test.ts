import { isTradingDay } from "@meridian/client";
import fc from "fast-check";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";

import {
  asOfSession,
  assertDemoTradingDate,
  formatEt,
  MIN_CLOSE_LEAD_SECS,
  parseCloseEt,
  parseIsoDate,
  selectDemoTradingDate,
  yyyymmdd,
} from "./dates";

const always = (): Promise<boolean> => Promise.resolve(true);
const SAT_NOON_ET = new Date("2026-10-10T16:00:00Z");

describe("parseIsoDate / yyyymmdd", () => {
  it("accepts a real date and converts it to the on-chain number", () => {
    expect(parseIsoDate(" 2026-10-11 ", "X")).toBe("2026-10-11");
    expect(yyyymmdd("2026-10-11")).toBe(20_261_011);
  });

  it("refuses malformed dates, naming the parameter", () => {
    expect(() => parseIsoDate("2026-02-30", "AS_OF")).toThrow(/AS_OF must be a real date/);
    expect(() => parseIsoDate("10/09/2026", "TRADING_DATE")).toThrow(/TRADING_DATE/);
  });
});

describe("asOfSession", () => {
  it("takes the previous session as the strike basis", () => {
    expect(asOfSession("2026-10-09")).toEqual({ asOf: "2026-10-09", prevDate: "2026-10-08" });
    expect(asOfSession("2026-10-12")).toEqual({ asOf: "2026-10-12", prevDate: "2026-10-09" });
    expect(asOfSession("2026-09-08")).toEqual({ asOf: "2026-09-08", prevDate: "2026-09-04" }); // after Labor Day
  });

  it("refuses an AS_OF that is not a session", () => {
    expect(() => asOfSession("2026-10-10")).toThrow(/not an NYSE trading day/);
    expect(() => asOfSession("2026-11-26")).toThrow(/not an NYSE trading day/);
  });
});

describe("assertDemoTradingDate", () => {
  it("accepts weekends and holidays", () => {
    expect(assertDemoTradingDate("2026-10-11")).toBe("2026-10-11");
    expect(assertDemoTradingDate("2026-12-25")).toBe("2026-12-25");
  });

  it("refuses a real trading day, including an early close", () => {
    expect(() => assertDemoTradingDate("2026-10-09")).toThrow(/is an NYSE trading day/);
    expect(() => assertDemoTradingDate("2026-11-27")).toThrow(/is an NYSE trading day/);
  });

  it("refuses every 2026 trading day and accepts every other day (property)", () => {
    const day = fc
      .integer({ min: 0, max: 364 })
      .map((n) => DateTime.fromISO("2026-01-01").plus({ days: n }).toISODate() ?? "");
    fc.assert(
      fc.property(day, (iso) => {
        if (isTradingDay(iso)) {
          expect(() => assertDemoTradingDate(iso)).toThrow();
        } else {
          expect(assertDemoTradingDate(iso)).toBe(iso);
        }
      }),
    );
  });
});

describe("selectDemoTradingDate", () => {
  it("returns a requested non-trading day and refuses a requested trading day", async () => {
    await expect(
      selectDemoTradingDate({ requested: "2026-10-11", now: SAT_NOON_ET, isFree: always }),
    ).resolves.toBe("2026-10-11");
    await expect(
      selectDemoTradingDate({ requested: "2026-10-12", now: SAT_NOON_ET, isFree: always }),
    ).rejects.toThrow(/is an NYSE trading day/);
  });

  it("defaults to today when today is a free weekend day (ET date, not UTC)", async () => {
    // 2026-10-11 01:30Z is still Saturday evening in New York.
    const now = new Date("2026-10-11T01:30:00Z");
    await expect(selectDemoTradingDate({ now, isFree: always })).resolves.toBe("2026-10-10");
  });

  it("skips occupied dates", async () => {
    const taken = new Set(["2026-10-10"]);
    await expect(
      selectDemoTradingDate({
        now: SAT_NOON_ET,
        isFree: (d) => Promise.resolve(!taken.has(d)),
      }),
    ).resolves.toBe("2026-10-11");
  });

  it("from a weekday picks the coming weekend; before Thanksgiving picks the holiday", async () => {
    await expect(
      selectDemoTradingDate({ now: new Date("2026-10-07T15:00:00Z"), isFree: always }),
    ).resolves.toBe("2026-10-10");
    await expect(
      selectDemoTradingDate({ now: new Date("2026-11-25T15:00:00Z"), isFree: always }),
    ).resolves.toBe("2026-11-26");
  });

  it("gives up when nothing is free", async () => {
    await expect(
      selectDemoTradingDate({ now: SAT_NOON_ET, isFree: () => Promise.resolve(false) }),
    ).rejects.toThrow(/no free non-trading day/);
  });

  it("always returns a non-trading day on or after today (property)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 300 }), async (offset) => {
        const now = DateTime.fromISO("2026-01-02T12:00", { zone: "America/New_York" })
          .plus({ days: offset })
          .toJSDate();
        const picked = await selectDemoTradingDate({ now, isFree: always });
        expect(isTradingDay(picked)).toBe(false);
        const today = DateTime.fromJSDate(now, { zone: "America/New_York" }).toISODate() ?? "";
        expect(picked >= today).toBe(true);
      }),
    );
  });
});

describe("parseCloseEt", () => {
  const now = new Date("2026-03-01T12:00:00Z");

  it("reads ET wall-clock time in EDT and in EST", () => {
    // Sunday Oct 11 2026 20:00 EDT = Oct 12 00:00Z.
    expect(parseCloseEt("2026-10-11 20:00", SAT_NOON_ET)).toBe(Date.UTC(2026, 9, 12, 0, 0) / 1000);
    // Saturday Nov 28 2026 20:00 EST = Nov 29 01:00Z.
    expect(parseCloseEt("2026-11-28T20:00", SAT_NOON_ET)).toBe(Date.UTC(2026, 10, 29, 1, 0) / 1000);
  });

  it("handles the days around both DST transitions", () => {
    // Spring forward on Mar 8 2026: 01:00 EST = 06:00Z, 03:00 EDT = 07:00Z.
    expect(parseCloseEt("2026-03-08 01:00", now)).toBe(Date.UTC(2026, 2, 8, 6, 0) / 1000);
    expect(parseCloseEt("2026-03-08 03:00", now)).toBe(Date.UTC(2026, 2, 8, 7, 0) / 1000);
    // Fall back on Nov 1 2026: 00:30 EDT = 04:30Z, 02:30 EST = 07:30Z.
    expect(parseCloseEt("2026-11-01 00:30", now)).toBe(Date.UTC(2026, 10, 1, 4, 30) / 1000);
    expect(parseCloseEt("2026-11-01 02:30", now)).toBe(Date.UTC(2026, 10, 1, 7, 30) / 1000);
  });

  it("refuses a time in the spring-forward gap and one in the repeated fall-back hour", () => {
    expect(() => parseCloseEt("2026-03-08 02:30", now)).toThrow(/does not exist/);
    expect(() => parseCloseEt("2026-11-01 01:30", now)).toThrow(/ambiguous/);
  });

  it("refuses malformed input", () => {
    for (const bad of ["2026-10-11", "20:00", "2026-10-11 8pm", "2026-10-11 25:00", ""]) {
      expect(() => parseCloseEt(bad, SAT_NOON_ET)).toThrow(/CLOSE must be/);
    }
  });

  it("refuses a close in the past or too soon", () => {
    expect(() => parseCloseEt("2026-10-09 16:00", SAT_NOON_ET)).toThrow(/in the future/);
    // 12:04 ET is less than MIN_CLOSE_LEAD_SECS after 12:00 ET.
    expect(MIN_CLOSE_LEAD_SECS).toBeGreaterThan(240);
    expect(() => parseCloseEt("2026-10-10 12:04", SAT_NOON_ET)).toThrow(/in the future/);
    expect(parseCloseEt("2026-10-10 12:05", SAT_NOON_ET)).toBe(SAT_NOON_ET.getTime() / 1000 + 300);
  });

  it("round-trips every unambiguous ET minute of 2026 (property)", () => {
    const minute = fc
      .integer({ min: 0, max: 364 * 24 * 60 })
      .map((m) =>
        DateTime.fromISO("2026-01-01T00:00", { zone: "America/New_York" }).plus({ minutes: m }),
      );
    fc.assert(
      fc.property(minute, (dt) => {
        const text = dt.toFormat("yyyy-MM-dd HH:mm");
        const ambiguous = dt.getPossibleOffsets().length > 1;
        const early = new Date("2025-12-01T00:00:00Z");
        if (ambiguous) {
          expect(() => parseCloseEt(text, early)).toThrow(/ambiguous/);
        } else {
          expect(parseCloseEt(text, early)).toBe(dt.toUnixInteger());
        }
      }),
    );
  });
});

describe("formatEt", () => {
  it("renders ET with weekday, in both offsets", () => {
    expect(formatEt(Date.UTC(2026, 9, 12, 0, 0) / 1000)).toBe("Sun Oct 11 2026 8:00 PM ET");
    expect(formatEt(Date.UTC(2026, 10, 29, 1, 0) / 1000)).toBe("Sat Nov 28 2026 8:00 PM ET");
  });
});
