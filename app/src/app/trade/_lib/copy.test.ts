import { describe, expect, it } from "vitest";

import { MIDPOINT_NOTE, openClose, question, settlementRule, sideMeanings, timeline } from "./copy";
import { market } from "@/test-utils";

// 2026-10-08: 16:00 ET close (EDT) = 20:00Z; early close 13:00 ET = 17:00Z.
const NORMAL = market({
  ticker: "NVDA",
  strikeCents: 18_000n,
  tradingDate: 20261008,
  closeTs: 1_791_489_600n,
});
const EARLY = market({
  ticker: "NVDA",
  strikeCents: 18_000n,
  tradingDate: 20261008,
  closeTs: 1_791_478_800n,
});
const NOW = 1_791_480_000; // 2026-10-08 during the trading day (ET)

describe("question (UI-04 AC9)", () => {
  it("carries the strike and the close time in ET", () => {
    expect(question(NORMAL, NOW)).toBe(
      "Will NVDA close at or above $180.00 at today's 16:00 ET close?",
    );
  });

  it("reads 13:00 on an early close, with no calendar", () => {
    expect(question(EARLY, NOW)).toBe(
      "Will NVDA close at or above $180.00 at today's 13:00 ET close?",
    );
  });

  it("names the date instead of `today` on another day", () => {
    expect(question(NORMAL, NOW + 2 * 86_400)).toBe(
      "Will NVDA close at or above $180.00 at the 2026-10-08 16:00 ET close?",
    );
  });
});

describe("settlement rule and timeline (UI-04 AC10)", () => {
  it("states the rule with the trading date and strike", () => {
    expect(settlementRule(NORMAL)).toBe(
      "Settles on the average of two official closing prices (Tiingo and Twelve Data) for 2026-10-08. YES wins at or above $180.00, NO wins below.",
    );
  });

  it("derives the timeline from close_ts: normal and early close", () => {
    expect(timeline(NORMAL)).toBe(
      "Trading stops 16:00 ET · Settlement about 16:05 ET · Redeem after settlement",
    );
    expect(timeline(EARLY)).toBe(
      "Trading stops 13:00 ET · Settlement about 13:05 ET · Redeem after settlement",
    );
  });
});

describe("openClose (D-050)", () => {
  it("shows the real creation time and the close in ET", () => {
    // created 08:30 EDT = 12:30Z
    expect(openClose(NORMAL, 1_791_462_600)).toBe("Opened 08:30 ET · Closes 16:00 ET");
  });

  it("shows — when the creation time is unreadable", () => {
    expect(openClose(NORMAL, null)).toBe("Opened — · Closes 16:00 ET");
  });

  it("says the open time is unavailable when the index cannot be read (P1-4)", () => {
    expect(openClose(NORMAL, "unavailable")).toBe("Open time unavailable · Closes 16:00 ET");
  });

  it("adds the date when the market was created on an earlier ET day", () => {
    // 2026-10-07 18:00 EDT = 22:00Z
    expect(openClose(NORMAL, 1_791_410_400)).toBe("Opened 2026-10-07 18:00 ET · Closes 16:00 ET");
  });

  it("is right across the fall-back DST boundary (2026-11-01, EST after 02:00)", () => {
    // 2026-11-02 trading day: close 16:00 EST = 21:00Z; created 09:00 EST = 14:00Z
    const m = market({ tradingDate: 20261102, closeTs: 1_793_653_200n });
    expect(openClose(m, 1_793_628_000)).toBe("Opened 09:00 ET · Closes 16:00 ET");
    // 2026-10-30 (EDT) close 16:00 = 20:00Z, created the previous evening 20:00 EDT = 00:00Z next day
    const friday = market({ tradingDate: 20261030, closeTs: 1_793_390_400n });
    expect(openClose(friday, 1_793_318_400)).toMatch(
      /^Opened 2026-10-29 20:00 ET · Closes 16:00 ET$/,
    );
  });

  it("is right across the spring-forward boundary (2027-03-08, EDT)", () => {
    // 2027-03-08 close 16:00 EDT = 20:00Z; created 09:00 EDT = 13:00Z
    const m = market({ tradingDate: 20270308, closeTs: 1_804_539_600n });
    expect(openClose(m, 1_804_514_400)).toBe("Opened 09:00 ET · Closes 16:00 ET");
  });
});

describe("static copy", () => {
  it("explains the midpoint", () => {
    expect(MIDPOINT_NOTE).toMatch(/midpoint of the best bid and ask/);
  });

  it("gives YES and NO a one-line meaning", () => {
    expect(sideMeanings(NORMAL)).toEqual({
      yes: "pays $1.00 if NVDA closes at or above $180",
      no: "pays $1.00 if NVDA closes below $180",
    });
  });
});
