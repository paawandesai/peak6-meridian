import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { closeTimeET, isTradingDay, previousTradingDay, tradingDateET } from "../src/calendar";

const utcSeconds = (iso: string): number => Date.parse(iso) / 1000;

/** ET wall clock of unix seconds via Intl (independent of luxon). */
const etClock = (unixSeconds: number): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(new Date(unixSeconds * 1000))
    .replace(",", "");

const allDates2026 = (): string[] => {
  const out: string[] = [];
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
};

describe("holidays and early closes (AC3)", () => {
  it("Thanksgiving Thu Nov 26 2026 is closed", () => {
    expect(isTradingDay("2026-11-26")).toBe(false);
    expect(() => closeTimeET("2026-11-26")).toThrow(/not an NYSE trading day/);
  });

  it("Fri Nov 27 2026 closes at 13:00 ET (18:00 UTC, EST)", () => {
    expect(isTradingDay("2026-11-27")).toBe(true);
    expect(closeTimeET("2026-11-27")).toEqual({
      hourET: 13,
      minuteET: 0,
      closeTs: utcSeconds("2026-11-27T18:00:00Z"),
    });
  });

  it("Thu Dec 24 2026 closes at 13:00 ET", () => {
    expect(closeTimeET("2026-12-24")).toEqual({
      hourET: 13,
      minuteET: 0,
      closeTs: utcSeconds("2026-12-24T18:00:00Z"),
    });
  });

  it("Christmas Fri Dec 25 2026 is closed", () => {
    expect(isTradingDay("2026-12-25")).toBe(false);
  });

  it.each([
    "2026-01-01",
    "2026-01-19",
    "2026-02-16",
    "2026-04-03",
    "2026-05-25",
    "2026-06-19",
    "2026-07-03",
    "2026-09-07",
  ])("earlier 2026 NYSE holiday %s is closed", (date) => {
    expect(isTradingDay(date)).toBe(false);
  });

  it("regular days close at 16:00 ET", () => {
    expect(closeTimeET("2026-10-06")).toEqual({
      hourET: 16,
      minuteET: 0,
      closeTs: utcSeconds("2026-10-06T20:00:00Z"),
    });
  });

  it("weekends are closed", () => {
    expect(isTradingDay("2026-10-03")).toBe(false);
    expect(isTradingDay("2026-10-04")).toBe(false);
    expect(isTradingDay("2026-10-05")).toBe(true);
  });

  it("2026 has 251 trading days (261 weekdays − 10 holidays)", () => {
    expect(allDates2026().filter(isTradingDay)).toHaveLength(251);
  });
});

describe("DST transitions (AC3)", () => {
  it("spring forward Sun Mar 8 2026: Fri Mar 6 closes 21:00 UTC (EST), Mon Mar 9 at 20:00 UTC (EDT)", () => {
    expect(isTradingDay("2026-03-08")).toBe(false);
    expect(closeTimeET("2026-03-06").closeTs).toBe(utcSeconds("2026-03-06T21:00:00Z"));
    expect(closeTimeET("2026-03-09").closeTs).toBe(utcSeconds("2026-03-09T20:00:00Z"));
  });

  it("fall back Sun Nov 1 2026: Fri Oct 30 closes 20:00 UTC (EDT), Mon Nov 2 at 21:00 UTC (EST)", () => {
    expect(isTradingDay("2026-11-01")).toBe(false);
    expect(closeTimeET("2026-10-30").closeTs).toBe(utcSeconds("2026-10-30T20:00:00Z"));
    expect(closeTimeET("2026-11-02").closeTs).toBe(utcSeconds("2026-11-02T21:00:00Z"));
  });

  it.each([
    ["2026-03-08T06:59:00Z", "2026-03-08"], // 01:59 EST, just before the jump
    ["2026-03-08T07:00:00Z", "2026-03-08"], // 03:00 EDT
    ["2026-03-09T03:59:00Z", "2026-03-08"], // 23:59 EDT
    ["2026-03-09T04:00:00Z", "2026-03-09"], // midnight EDT
    ["2026-11-01T03:59:00Z", "2026-10-31"], // 23:59 EDT
    ["2026-11-01T04:00:00Z", "2026-11-01"], // midnight EDT
    ["2026-11-02T04:59:00Z", "2026-11-01"], // 23:59 EST
    ["2026-11-02T05:00:00Z", "2026-11-02"], // midnight EST
  ])("tradingDateET(%s) = %s", (instant, date) => {
    expect(tradingDateET(new Date(instant))).toBe(date);
  });

  it("every 2026 trading day closes at its ET hour on its own ET date (checked with Intl)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...allDates2026().filter(isTradingDay)), (date) => {
        const { hourET, closeTs } = closeTimeET(date);
        expect(etClock(closeTs)).toBe(`${date} ${String(hourET)}:00`);
      }),
      { numRuns: 300 },
    );
  });
});

describe("previousTradingDay", () => {
  it.each([
    ["2026-10-06", "2026-10-05"],
    ["2026-10-05", "2026-10-02"], // over a weekend
    ["2026-11-27", "2026-11-25"], // over Thanksgiving
    ["2026-12-28", "2026-12-24"], // over Christmas and a weekend
    ["2026-07-06", "2026-07-02"], // over Independence Day (observed) and a weekend
  ])("before %s is %s", (date, prev) => {
    expect(previousTradingDay(date)).toBe(prev);
  });

  it("refuses to walk into an unsupported year", () => {
    expect(() => previousTradingDay("2026-01-02")).toThrow(/outside the NYSE holiday tables/);
  });
});

describe("input validation", () => {
  it.each(["2026-02-30", "20261005", "2026-1-5", "", "2026-10-05T00:00"])(
    "rejects malformed date %j",
    (bad) => {
      expect(() => isTradingDay(bad)).toThrow(/expected an ET date/);
    },
  );

  it.each(["2025-12-31", "2027-01-04"])("rejects unsupported year %s", (date) => {
    expect(() => isTradingDay(date)).toThrow(/outside the NYSE holiday tables/);
    expect(() => closeTimeET(date)).toThrow(RangeError);
  });

  it("rejects an invalid instant", () => {
    expect(() => tradingDateET(new Date(Number.NaN))).toThrow(/invalid instant/);
  });
});
