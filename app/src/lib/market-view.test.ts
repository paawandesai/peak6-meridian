import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  badgeProps,
  nextTransition,
  openCloseText,
  rangeText,
  WIDE_SPREAD_CENTS,
  yesView,
} from "./market-view";
import { marketStatus } from "./markets";
import { market } from "@/test-utils";

const quotes = (bid: number | null, ask: number | null) => ({
  yesBid: bid,
  yesAsk: ask,
  yesMid: bid !== null && ask !== null && bid <= ask ? Math.floor((bid + ask) / 2) : null,
  noPrice: null,
});

describe("yesView (displayed-price rule)", () => {
  it("shows the midpoint and a derived NO when both sides exist and the spread is at most 10c", () => {
    expect(yesView(quotes(58, 60))).toEqual({ kind: "mid", yes: 59, no: 41, probability: 59 });
    // exactly 10c is still a midpoint
    expect(yesView(quotes(50, 60))).toMatchObject({ kind: "mid", yes: 55, no: 45 });
    expect(WIDE_SPREAD_CENTS).toBe(10);
  });

  it("shows a bid and ask range for a spread over 10c, with the derived NO range", () => {
    expect(yesView(quotes(50, 61))).toEqual({
      kind: "range",
      bid: 50,
      ask: 61,
      noBid: 39,
      noAsk: 50,
    });
  });

  it("a one-sided book is a range with only the derived side that exists", () => {
    expect(yesView(quotes(40, null))).toEqual({
      kind: "range",
      bid: 40,
      ask: null,
      noBid: null,
      noAsk: 60,
    });
    expect(yesView(quotes(null, 70))).toEqual({
      kind: "range",
      bid: null,
      ask: 70,
      noBid: 30,
      noAsk: null,
    });
  });

  it("is none when there is no book or neither side", () => {
    expect(yesView(undefined)).toEqual({ kind: "none" });
    expect(yesView(null)).toEqual({ kind: "none" });
    expect(yesView(quotes(null, null))).toEqual({ kind: "none" });
  });

  it("midpoint case: NO = 100 - YES mid for every tight bid/ask pair in 1-99 (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99 }),
        fc.integer({ min: 0, max: 10 }),
        (bid, spread) => {
          const ask = Math.min(99, bid + spread);
          const view = yesView(quotes(bid, ask));
          expect(view.kind).toBe("mid");
          if (view.kind === "mid") {
            expect(view.no).toBe(100 - view.yes);
            expect(view.probability).toBe(view.yes);
          }
        },
      ),
    );
  });

  it("range case: NO bid = 100 - YES ask and NO ask = 100 - YES bid for every wide pair (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 88 }),
        fc.integer({ min: 11, max: 98 }),
        (bid, spread) => {
          const ask = bid + spread;
          fc.pre(ask <= 99);
          const view = yesView(quotes(bid, ask));
          expect(view).toEqual({ kind: "range", bid, ask, noBid: 100 - ask, noAsk: 100 - bid });
        },
      ),
    );
  });
});

describe("rangeText", () => {
  it("formats ranges, single sides and nothing", () => {
    expect(rangeText(55, 70)).toBe("55–70¢");
    expect(rangeText(55, 55)).toBe("55¢");
    expect(rangeText(40, null)).toBe("40¢");
    expect(rangeText(null, 70)).toBe("70¢");
    expect(rangeText(null, null)).toBe("—");
  });
});

describe("badgeProps (design.md §3 precedence)", () => {
  const close = 2_000_000_000n;
  const m = market({ closeTs: close });
  const ctx = (nowSecs: number, paused = false) => ({ nowSecs, paused, overrideDelaySecs: 3_600n });
  const statusAt = (offset: number, paused = false) => {
    const now = Number(close) + offset;
    return badgeProps(m, marketStatus(m, now), ctx(now, paused));
  };

  it("maps each time-based state", () => {
    expect(statusAt(-5_000)).toMatchObject({ state: "open" });
    expect(statusAt(-300)).toEqual({ state: "closing-soon", remaining: "05:00" });
    expect(statusAt(10)).toMatchObject({ state: "closed" });
    expect(statusAt(400)).toEqual({ state: "settling" });
  });

  it("Settlement delayed names the override time before close + delay and 'now' from then on", () => {
    expect(statusAt(1_300)).toMatchObject({ state: "settlement-delayed" });
    const before = statusAt(1_300);
    const at = statusAt(3_600);
    const after = statusAt(9_999);
    expect(before.state === "settlement-delayed" && before.overrideAt).toMatch(/^\d\d:\d\d$/);
    expect(at).toEqual({ state: "settlement-delayed", overrideAt: "now" });
    expect(after).toEqual({ state: "settlement-delayed", overrideAt: "now" });
  });

  it("Paused applies only to an otherwise Open or Closing soon market", () => {
    expect(statusAt(-5_000, true)).toEqual({ state: "paused" });
    expect(statusAt(-300, true)).toEqual({ state: "paused" });
    expect(statusAt(10, true)).toMatchObject({ state: "closed" });
    expect(statusAt(400, true)).toEqual({ state: "settling" });
    const settled = market({ closeTs: close, settled: true, outcome: "Yes" });
    expect(badgeProps(settled, "Settled", ctx(Number(close) + 10, true))).toMatchObject({
      state: "settled",
      outcome: "YES",
    });
  });

  it("Settled shows the outcome and the floored settle price", () => {
    const yes = market({
      settled: true,
      outcome: "Yes",
      settlePriceScaled: 181_426_000_000_000_000_000n,
    });
    expect(badgeProps(yes, "Settled", ctx(0))).toEqual({
      state: "settled",
      outcome: "YES",
      price: "$181.42",
    });
    const no = market({
      settled: true,
      outcome: "No",
      settlePriceScaled: 178_100_000_000_000_000_000n,
    });
    expect(badgeProps(no, "Settled", ctx(0))).toEqual({
      state: "settled",
      outcome: "NO",
      price: "$178.10",
    });
  });
});

describe("nextTransition (countdown to the next state change, D-050)", () => {
  const close = 100_000;
  const m = market({ closeTs: BigInt(close) });
  const at = (status: Parameters<typeof nextTransition>[1], now: number) =>
    nextTransition(m, status, now, 3_600n);

  it("counts down to each next boundary", () => {
    expect(at("Closed", close + 60)).toEqual({ label: "Settlement starts in", secondsLeft: 240 });
    expect(at("Settling", close + 400)).toEqual({
      label: "Settlement delayed in",
      secondsLeft: 800,
    });
    expect(at("SettlementDelayed", close + 1_300)).toEqual({
      label: "Admin override opens in",
      secondsLeft: 2_300,
    });
  });

  it("has none for Open (badge shows close time), Closing soon (badge counts down), reached override, and Settled", () => {
    expect(at("Open", close - 5_000)).toBeNull();
    expect(at("ClosingSoon", close - 100)).toBeNull();
    expect(at("SettlementDelayed", close + 3_600)).toBeNull();
    expect(at("Settled", close + 10)).toBeNull();
  });
});

describe("openCloseText", () => {
  it("prints the creation time and the close time in ET", () => {
    const open = Math.floor(Date.parse("2026-10-08T13:00:00Z") / 1000); // 09:00 EDT
    const close = BigInt(Math.floor(Date.parse("2026-10-08T20:00:00Z") / 1000)); // 16:00 EDT
    expect(openCloseText(open, close)).toBe("Opened 09:00 ET · closes 16:00 ET");
    expect(openCloseText(null, close)).toBe("Opened — · closes 16:00 ET");
  });
  it("renders ET across a DST boundary (opened in EST, closes in EDT; and the reverse)", () => {
    const secs = (iso: string) => Math.floor(Date.parse(iso) / 1000);
    // 2026-03-08: clocks spring forward at 02:00 ET. 13:00Z the day before is 08:00 EST; close 20:00Z is 16:00 EDT.
    expect(openCloseText(secs("2026-03-07T13:00:00Z"), BigInt(secs("2026-03-09T20:00:00Z")))).toBe(
      "Opened 08:00 ET · closes 16:00 ET",
    );
    // 2026-11-01: clocks fall back. 13:00Z in October is 09:00 EDT; close 21:00Z in November is 16:00 EST.
    expect(openCloseText(secs("2026-10-31T13:00:00Z"), BigInt(secs("2026-11-02T21:00:00Z")))).toBe(
      "Opened 09:00 ET · closes 16:00 ET",
    );
  });
});
