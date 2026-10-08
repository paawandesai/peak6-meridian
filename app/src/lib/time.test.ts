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

describe("nextClose (header rule)", () => {
  const NOW = utc("2026-10-08T19:00:00Z"); // 15:00 ET
  const date = 20261008;
  const closeNormal = BigInt(utc("2026-10-08T20:00:00Z")); // 16:00 ET
  const closeEarly = BigInt(utc("2026-10-08T17:00:00Z")); // 13:00 ET (already past at NOW)

  it("counts down to the smallest open close_ts, including Closing soon markets", () => {
    const a = market({ address: "a", tradingDate: date, closeTs: closeNormal });
    const b = market({ address: "b", tradingDate: date, closeTs: closeNormal - 60n });
    const result = nextClose([a, b], NOW + 3_600 - 600); // 15:50 ET: both within the final 15 minutes
    expect(result).toEqual({ kind: "countdown", closeTs: closeNormal - 60n, secondsLeft: 540 });
  });

  it("uses an early-close market's own 13:00 ET close_ts without a calendar", () => {
    const early = market({ tradingDate: date, closeTs: closeEarly });
    const now = utc("2026-10-08T16:30:00Z"); // 12:30 ET
    expect(nextClose([early], now)).toEqual({
      kind: "countdown",
      closeTs: closeEarly,
      secondsLeft: 1_800,
    });
    expect(formatEtHm(Number(closeEarly))).toBe("13:00");
  });

  it("a market in its final 15 minutes is still the target, not 'Closed · settling'", () => {
    const m = market({ tradingDate: date, closeTs: closeNormal });
    expect(nextClose([m], Number(closeNormal) - 300).kind).toBe("countdown");
  });

  it("'No markets today' for an empty reader result", () => {
    expect(nextClose([], NOW)).toEqual({ kind: "none" });
  });

  it("'Closed · settling' once nothing is open but something is unsettled", () => {
    const m = market({ tradingDate: date, closeTs: closeNormal });
    expect(nextClose([m], Number(closeNormal) + 10)).toEqual({ kind: "closed-settling" });
    expect(nextClose([m], Number(closeNormal) + 600)).toEqual({ kind: "closed-settling" }); // Settling
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

  it("only the active date counts: an older date's open market does not drive the countdown", () => {
    const old = market({ address: "o", tradingDate: 20261007, closeTs: closeNormal + 9_999_999n });
    const today = market({ address: "t", tradingDate: date, closeTs: closeNormal, settled: true });
    expect(nextClose([old, today], NOW)).toEqual({ kind: "markets-closed" });
  });
});
