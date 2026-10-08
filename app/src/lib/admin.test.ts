import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { adminErrorText, validateAddStrike } from "./admin";
import { market } from "@/test-utils";

// 2026-01-05 14:00 ET.
const NOW = 1_767_639_600;
const CLOSE = BigInt(NOW + 3 * 3600);
const today = (overrides = {}) => market({ tradingDate: 20260105, closeTs: CLOSE, ...overrides });

const check = (over: Partial<Parameters<typeof validateAddStrike>[0]> = {}) =>
  validateAddStrike({
    ticker: "AAPL",
    strikeText: "230",
    markets: [today()],
    nowSecs: NOW,
    ...over,
  });

describe("validateAddStrike", () => {
  it("accepts a new strike and takes the close from today's markets", () => {
    expect(check()).toEqual({
      ok: true,
      params: { ticker: "AAPL", strikeCents: 23_000n, tradingDate: 20260105, closeTs: CLOSE },
    });
    expect(check({ strikeText: " $230 " }).ok).toBe(true);
  });

  it("rejects a duplicate with clear text", () => {
    const result = check({ strikeText: "220", markets: [today({ strikeCents: 22_000n })] });
    expect(result).toEqual({
      ok: false,
      message: "AAPL $220 already exists for today. Choose a different strike.",
    });
    expect(check({ ticker: "MSFT", strikeText: "220", markets: [today()] }).ok).toBe(true);
  });

  it("rejects a past close with clear text", () => {
    const result = check({ markets: [today({ closeTs: BigInt(NOW - 60) })] });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.message).toMatch(/closed at 13:59 ET.*after the close/);
    expect(check({ markets: [today({ closeTs: BigInt(NOW) })] }).ok).toBe(false);
  });

  it("explains when there are no markets today", () => {
    const result = check({ markets: [today({ tradingDate: 20260102 })] });
    expect(result.ok ? "" : result.message).toMatch(/no markets for today/);
  });

  it("rejects unknown tickers and malformed strikes", () => {
    expect(check({ ticker: "IBM" }).ok).toBe(false);
    for (const strikeText of ["", "abc", "-10", "0", "225", "12.5", "99999999"]) {
      expect(check({ strikeText }).ok).toBe(false);
    }
  });

  it("accepts exactly the positive multiples of 10 (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9_999 }), (dollars) => {
        const result = check({ strikeText: String(dollars), markets: [] });
        // With no markets the result is always a failure; use a market on another ticker.
        expect(result.ok).toBe(false);
        const real = check({ strikeText: String(dollars), markets: [today({ ticker: "TSLA" })] });
        expect(real.ok).toBe(dollars % 10 === 0);
      }),
    );
  });
});

describe("adminErrorText", () => {
  it("uses the error message and never returns an empty string", () => {
    expect(adminErrorText(new Error("User rejected the request"))).toBe(
      "User rejected the request",
    );
    expect(adminErrorText(new Error(" "))).toBe("unknown error");
    expect(adminErrorText("boom")).toBe("boom");
  });
});
