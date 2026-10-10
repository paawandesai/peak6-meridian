// @vitest-environment node
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  activeDateMarkets,
  etTradingDate,
  formatCountdown,
  formatEtHm,
  formatEtHms,
  nextClose,
  sessionCloseTs,
} from "./time";
import { market } from "@/test-utils";

/** Unix seconds of an instant given in UTC. */
const utc = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe("ET formatting (Intl, America/New_York)", () => {
  it("is UTC-4 in summer and UTC-5 in winter", () => {
    expect(formatEtHms(utc("2026-07-15T18:52:07Z"))).toBe("14:52:07"); // EDT
    expect(formatEtHms(utc("2026-01-15T19:52:07Z"))).toBe("14:52:07"); // EST
  });

  it("follows the DST boundaries (spring forward 2026-03-08, fall back 2026-11-01)", () => {
    // 2026-03-08 06:59:59Z is 01:59:59 EST; one second later is 03:00:00 EDT.
    expect(formatEtHms(utc("2026-03-08T06:59:59Z"))).toBe("01:59:59");
    expect(formatEtHms(utc("2026-03-08T07:00:00Z"))).toBe("03:00:00");
    // 2026-11-01 05:59:59Z is 01:59:59 EDT; one second later is 01:00:00 EST again.
    expect(formatEtHms(utc("2026-11-01T05:59:59Z"))).toBe("01:59:59");
    expect(formatEtHms(utc("2026-11-01T06:00:00Z"))).toBe("01:00:00");
  });

  it("renders the normal 16:00 close and the early 13:00 close, and close + 5 min", () => {
    expect(formatEtHm(utc("2026-10-08T20:00:00Z"))).toBe("16:00");
    expect(formatEtHm(utc("2026-10-08T20:05:00Z"))).toBe("16:05");
    expect(formatEtHm(utc("2026-11-27T18:00:00Z"))).toBe("13:00"); // day after Thanksgiving (EST)
    expect(formatEtHm(utc("2026-11-27T18:05:00Z"))).toBe("13:05");
    expect(formatEtHm(1_700_000_000n)).toMatch(/^\d\d:\d\d$/);
  });

  it("takes the ET calendar date, not the UTC one", () => {
    expect(etTradingDate(utc("2026-10-08T03:30:00Z"))).toBe(20261007); // 23:30 ET the day before
    expect(etTradingDate(utc("2026-10-08T14:00:00Z"))).toBe(20261008);
  });
});

describe("formatCountdown", () => {
  it("formats mm:ss, h:mm:ss and clamps below zero", () => {
    expect(formatCountdown(724)).toBe("12:04");
    expect(formatCountdown(3_724)).toBe("1:02:04");
    expect(formatCountdown(0)).toBe("00:00");
    expect(formatCountdown(-5)).toBe("00:00");
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 86_399 }), (s) => {
        const text = formatCountdown(s);
        const parts = text.split(":").map(Number);
        const total =
          parts.length === 3
            ? (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0)
            : (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
        expect(total).toBe(s);
      }),
    );
  });
});

describe("activeDateMarkets", () => {
  it("scopes to today's ET date when present, else the most recent date", () => {
    const now = utc("2026-10-08T14:00:00Z");
    const today = market({ address: "t", tradingDate: 20261008 });
    const yesterday = market({ address: "y", tradingDate: 20261007 });
    expect(activeDateMarkets([today, yesterday], now).map((m) => m.address)).toEqual(["t"]);
    expect(activeDateMarkets([yesterday], now).map((m) => m.address)).toEqual(["y"]);
    expect(activeDateMarkets([], now)).toEqual([]);
  });
});

describe("nextClose (header rule, P0-1 session markets only)", () => {
  const NOW = utc("2026-10-08T19:00:00Z"); // 15:00 ET
  const date = 20261008;
  const closeNormal = BigInt(utc("2026-10-08T20:00:00Z")); // 16:00 ET (session close)
  const closeTest = BigInt(utc("2026-10-08T19:00:00Z")); // 15:00 ET (test market, not session)

  it("counts down to the session close, ignoring test markets", () => {
    // P0-1: only session markets (closeTs matching the NYSE session close) drive the header
    const sessionMarket = market({ address: "a", tradingDate: date, closeTs: closeNormal });
    const testMarket = market({ address: "b", tradingDate: date, closeTs: closeTest });
    const result = nextClose([sessionMarket, testMarket], NOW); // 15:00 ET: 1 hour before session close
    expect(result).toEqual({ kind: "countdown", closeTs: closeNormal, secondsLeft: 3_600, hourET: 16 });
  });

  it("uses an early-close session market's 13:00 ET close_ts", () => {
    // November 27, 2026 is an early-close day (day after Thanksgiving)
    const earlyDate = 20261127;
    const earlyClose = BigInt(utc("2026-11-27T18:00:00Z")); // 13:00 EST
    const early = market({ tradingDate: earlyDate, closeTs: earlyClose });
    const now = utc("2026-11-27T17:30:00Z"); // 12:30 EST
    expect(nextClose([early], now)).toEqual({
      kind: "countdown",
      closeTs: earlyClose,
      secondsLeft: 1_800,
      hourET: 13,
    });
    expect(formatEtHm(Number(earlyClose))).toBe("13:00");
  });

  it("a market in its final 15 minutes is still the target, not 'Closed · settling'", () => {
    const m = market({ tradingDate: date, closeTs: closeNormal });
    expect(nextClose([m], Number(closeNormal) - 300).kind).toBe("countdown");
  });

  it("'No markets today' for an empty reader on a weekday", () => {
    // Empty reader on a trading day (Thu Oct 8) shows "none"
    expect(nextClose([], NOW)).toEqual({ kind: "none" });
  });

  it("'Next session' for an empty reader on a weekend", () => {
    // Empty reader on a Saturday should show next session
    const satNoon = utc("2026-10-11T16:00:00Z"); // Saturday Oct 11 at noon
    const result = nextClose([], satNoon);
    expect(result.kind).toBe("next-session");
    if (result.kind === "next-session") {
      expect(result.dayName).toBe("Mon");
      expect(result.openTime).toBe("9:30 AM");
    }
  });

  it("'Closed · settling' once nothing is open but something is unsettled", () => {
    const m = market({ tradingDate: date, closeTs: closeNormal });
    expect(nextClose([m], Number(closeNormal) + 10)).toEqual({
      kind: "closed-settling",
      settlingAt: closeNormal + 5n * 60n,
    });
    expect(nextClose([m], Number(closeNormal) + 600)).toEqual({
      kind: "closed-settling",
      settlingAt: closeNormal + 5n * 60n,
    }); // Settling
  });

  it("'Settlement delayed' wins over 'Closed · settling' when any unsettled market is delayed", () => {
    const delayed = market({ address: "d", tradingDate: date, closeTs: closeNormal });
    const settling = market({ address: "s", tradingDate: date, closeTs: closeNormal + 1_000n });
    const now = Number(closeNormal) + 1_300; // delayed: past +20 min; the other is Settling
    expect(nextClose([delayed, settling], now)).toEqual({ kind: "settlement-delayed" });
  });

  it("'Markets closed' when every market is settled", () => {
    const m = market({ tradingDate: date, closeTs: closeNormal, settled: true });
    expect(nextClose([m], Number(closeNormal) + 5_000)).toEqual({ kind: "markets-closed" });
  });

  it("'Next session Mon 9:30 AM ET' on weekends when all settled", () => {
    // Saturday Oct 11, 2026 at noon ET (all Friday markets settled)
    const satNoon = utc("2026-10-11T16:00:00Z");
    const friClose = BigInt(utc("2026-10-10T20:00:00Z")); // Friday 16:00 ET
    const m = market({ tradingDate: 20261010, closeTs: friClose, settled: true });
    const result = nextClose([m], satNoon);
    expect(result.kind).toBe("next-session");
    if (result.kind === "next-session") {
      expect(result.dayName).toBe("Mon"); // Next trading day is Monday Oct 13
      expect(result.openTime).toBe("9:30 AM");
    }
  });

  it("includes all session markets across dates: an older date's session market can drive the countdown", () => {
    // P0-1: both markets must be session markets (closeTs matching their date's session close)
    const oct7Close = BigInt(utc("2026-10-07T20:00:00Z")); // Oct 7, 2026 16:00 EDT
    const old = market({ address: "o", tradingDate: 20261007, closeTs: oct7Close, settled: false });
    const today = market({ address: "t", tradingDate: date, closeTs: closeNormal, settled: true });
    const farFuture = utc("2026-10-06T14:00:00Z"); // before both closes
    expect(nextClose([old, today], farFuture)).toMatchObject({
      kind: "countdown",
      closeTs: oct7Close,
      hourET: 16,
    });
  });

  it("ignores test markets even if they would close sooner", () => {
    // Test market (not a session market) is ignored even though it closes first
    const sessionMarket = market({ tradingDate: date, closeTs: closeNormal });
    const testMarket = market({ tradingDate: date, closeTs: closeTest });
    expect(nextClose([sessionMarket, testMarket], NOW)).toMatchObject({
      kind: "countdown",
      closeTs: closeNormal,
    });
  });
});

describe("sessionCloseTs (P0-1)", () => {
  it("returns 16:00 ET for a regular trading day (EDT and EST)", () => {
    // October 8, 2026 is a regular Wednesday (EDT)
    const ts = sessionCloseTs(20261008);
    expect(ts).toBe(utc("2026-10-08T20:00:00Z")); // 16:00 EDT = UTC-4
    if (ts !== null) expect(formatEtHm(ts)).toBe("16:00");

    // January 15, 2026 is a regular Thursday (EST)
    const tsWinter = sessionCloseTs(20260115);
    expect(tsWinter).toBe(utc("2026-01-15T21:00:00Z")); // 16:00 EST = UTC-5
    if (tsWinter !== null) expect(formatEtHm(tsWinter)).toBe("16:00");
  });

  it("returns 13:00 ET for an early-close day (day after Thanksgiving)", () => {
    // November 27, 2026 is the day after Thanksgiving (early close)
    const ts = sessionCloseTs(20261127);
    expect(ts).toBe(utc("2026-11-27T18:00:00Z")); // 13:00 EST = UTC-5
    if (ts !== null) expect(formatEtHm(ts)).toBe("13:00");
  });

  it("returns 13:00 ET for Christmas Eve early close", () => {
    // December 24, 2026 is Christmas Eve (early close)
    const ts = sessionCloseTs(20261224);
    expect(ts).toBe(utc("2026-12-24T18:00:00Z")); // 13:00 EST = UTC-5
    if (ts !== null) expect(formatEtHm(ts)).toBe("13:00");
  });

  it("returns null for a weekend", () => {
    // October 10, 2026 is a Saturday
    expect(sessionCloseTs(20261010)).toBe(null);
    // October 11, 2026 is a Sunday
    expect(sessionCloseTs(20261011)).toBe(null);
  });

  it("returns null for an NYSE holiday", () => {
    // January 1, 2026 is New Year's Day
    expect(sessionCloseTs(20260101)).toBe(null);
    // November 26, 2026 is Thanksgiving
    expect(sessionCloseTs(20261126)).toBe(null);
    // December 25, 2026 is Christmas
    expect(sessionCloseTs(20261225)).toBe(null);
  });

  it("returns null for an invalid date or date outside supported years", () => {
    expect(sessionCloseTs(20251008)).toBe(null); // 2025 not in SUPPORTED_YEARS
    expect(sessionCloseTs(20271008)).toBe(null); // 2027 not in SUPPORTED_YEARS
    expect(sessionCloseTs(20269999)).toBe(null); // invalid date
  });
});
