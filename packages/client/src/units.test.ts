import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  assertPriceCents,
  assertQty,
  assertStrikeCents,
  BASE_UNITS_PER_CENT,
  BASE_UNITS_PER_USDC,
  baseUnitsToCents,
  centsToBaseUnits,
  closesAtOrAbove,
  complementPriceCents,
  contractCost,
  dollarsToStrikeCents,
  formatUsdc,
  isValidPriceCents,
  isValidQty,
  isValidStrikeCents,
  pairCollateral,
  parseTradingDate,
  parseUsdc,
  STRIKE_CENTS_TO_SCALED,
  strikeCentsToDollars,
  strikeCentsToScaled,
  tradingDate,
  UnitError,
} from "./units";

const cents = fc.bigInt({ min: 0n, max: 10n ** 15n });
const price = fc.integer({ min: 1, max: 99 });
const qty = fc.bigInt({ min: 1n, max: 2n ** 40n });
const dollars = fc.bigInt({ min: 0n, max: 10n ** 9n });
const strikeTens = fc.bigInt({ min: 1n, max: 10n ** 7n });

describe("cents ↔ USDC base units", () => {
  it("1 USDC = 100 cents = 1,000,000 base units", () => {
    expect(centsToBaseUnits(100n)).toBe(BASE_UNITS_PER_USDC);
    expect(baseUnitsToCents(1_000_000n)).toBe(100n);
    expect(BASE_UNITS_PER_CENT).toBe(10_000n);
  });

  it("round-trips exactly for any amount of cents", () => {
    fc.assert(fc.property(cents, (c) => baseUnitsToCents(centsToBaseUnits(c)) === c));
  });

  it("rejects base units that are not a whole number of cents", () => {
    fc.assert(
      fc.property(cents, fc.bigInt({ min: 1n, max: 9_999n }), (c, rest) => {
        expect(() => baseUnitsToCents(c * 10_000n + rest)).toThrow(UnitError);
        return true;
      }),
    );
  });

  it("rejects negative amounts", () => {
    expect(() => centsToBaseUnits(-1n)).toThrow(UnitError);
    expect(() => baseUnitsToCents(-10_000n)).toThrow(UnitError);
  });
});

describe("contract cost and pair collateral", () => {
  it("1 contract at 62¢ costs 620,000 base units", () => {
    expect(contractCost(62, 1n)).toBe(620_000n);
    expect(contractCost(1, 1n)).toBe(10_000n);
    expect(contractCost(99, 10n)).toBe(9_900_000n);
  });

  it("buying YES at p and NO at 100 − p costs exactly one pair (the Buy NO identity)", () => {
    fc.assert(
      fc.property(price, qty, (p, q) => {
        const yes = contractCost(p, q);
        const no = contractCost(complementPriceCents(p), q);
        return yes + no === pairCollateral(q) && yes === centsToBaseUnits(BigInt(p) * q);
      }),
    );
  });

  it("complement is an involution on 1–99", () => {
    fc.assert(
      fc.property(price, (p) => {
        const no = complementPriceCents(p);
        return isValidPriceCents(no) && complementPriceCents(no) === p && no + p === 100;
      }),
    );
  });

  it("rejects prices outside 1–99 and non-integers", () => {
    for (const bad of [0, 100, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isValidPriceCents(bad)).toBe(false);
      expect(() => assertPriceCents(bad)).toThrow(UnitError);
      expect(() => contractCost(bad, 1n)).toThrow(UnitError);
      expect(() => complementPriceCents(bad)).toThrow(UnitError);
    }
    expect(assertPriceCents(50)).toBe(50);
  });

  it("rejects quantities below 1 contract", () => {
    expect(isValidQty(0n)).toBe(false);
    expect(isValidQty(1n)).toBe(true);
    expect(() => assertQty(0n)).toThrow(UnitError);
    expect(() => contractCost(50, 0n)).toThrow(UnitError);
    expect(() => contractCost(50, -1n)).toThrow(UnitError);
    expect(() => pairCollateral(-1n)).toThrow(UnitError);
    expect(pairCollateral(0n)).toBe(0n);
  });
});

describe("strike cents", () => {
  it("$680 → 68,000 cents and back", () => {
    expect(dollarsToStrikeCents(680n)).toBe(68_000n);
    expect(strikeCentsToDollars(68_000n)).toBe(680n);
  });

  it("round-trips any whole-dollar strike", () => {
    fc.assert(fc.property(dollars, (d) => strikeCentsToDollars(dollarsToStrikeCents(d)) === d));
  });

  it("rejects fractional dollars and negatives", () => {
    expect(() => strikeCentsToDollars(68_050n)).toThrow(UnitError);
    expect(() => strikeCentsToDollars(-100n)).toThrow(UnitError);
    expect(() => dollarsToStrikeCents(-1n)).toThrow(UnitError);
  });

  it("valid strikes are exactly the positive multiples of $10", () => {
    fc.assert(
      fc.property(strikeTens, fc.bigInt({ min: 1n, max: 999n }), (tens, offset) => {
        const strike = tens * 1_000n;
        return (
          isValidStrikeCents(strike) &&
          assertStrikeCents(strike) === strike &&
          !isValidStrikeCents(strike + offset)
        );
      }),
    );
    expect(isValidStrikeCents(0n)).toBe(false);
    expect(() => assertStrikeCents(0n)).toThrow(UnitError);
    expect(() => assertStrikeCents(-1_000n)).toThrow(UnitError);
  });

  it("scales to the oracle's 18 fractional digits and settles at-or-above, exactly", () => {
    expect(STRIKE_CENTS_TO_SCALED).toBe(10_000_000_000_000_000n);
    expect(strikeCentsToScaled(68_000n)).toBe(680n * 10n ** 18n);
    expect(() => strikeCentsToScaled(-1n)).toThrow(UnitError);
    fc.assert(
      fc.property(strikeTens, fc.bigInt({ min: 1n, max: 10n ** 16n }), (tens, delta) => {
        const strike = tens * 1_000n;
        const exact = strikeCentsToScaled(strike);
        return (
          closesAtOrAbove(exact, strike) &&
          closesAtOrAbove(exact + delta, strike) &&
          !closesAtOrAbove(exact - delta, strike)
        );
      }),
    );
  });
});

describe("USDC text", () => {
  it("formats with six decimals", () => {
    expect(formatUsdc(0n)).toBe("0.000000");
    expect(formatUsdc(1_250_000n)).toBe("1.250000");
    expect(formatUsdc(1n)).toBe("0.000001");
    expect(() => formatUsdc(-1n)).toThrow(UnitError);
  });

  it("parses exactly", () => {
    expect(parseUsdc("1.25")).toBe(1_250_000n);
    expect(parseUsdc("1")).toBe(1_000_000n);
    expect(parseUsdc(" 0.000001 ")).toBe(1n);
    for (const bad of ["", "-1", "1.2345678", "1e6", "abc", ".5", "1."]) {
      expect(() => parseUsdc(bad)).toThrow(UnitError);
    }
  });

  it("round-trips any amount", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 18n }), (units) => {
        return parseUsdc(formatUsdc(units)) === units;
      }),
    );
  });
});

describe("trading date", () => {
  it("encodes YYYYMMDD", () => {
    expect(tradingDate(2026, 10, 6)).toBe(20261006);
    expect(parseTradingDate(20261006)).toEqual({ year: 2026, month: 10, day: 6 });
    expect(tradingDate(2028, 2, 29)).toBe(20280229);
  });

  it("rejects impossible dates", () => {
    expect(() => tradingDate(2026, 13, 1)).toThrow(UnitError);
    expect(() => tradingDate(2026, 2, 29)).toThrow(UnitError);
    expect(() => tradingDate(2026, 4, 31)).toThrow(UnitError);
    expect(() => tradingDate(2026, 0, 1)).toThrow(UnitError);
    expect(() => tradingDate(2026.5, 1, 1)).toThrow(UnitError);
    expect(() => tradingDate(1969, 12, 31)).toThrow(UnitError);
    expect(() => parseTradingDate(20261306)).toThrow(UnitError);
    expect(() => parseTradingDate(2026)).toThrow(UnitError);
    expect(() => parseTradingDate(20261006.5)).toThrow(UnitError);
  });

  it("round-trips any calendar date", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1970, max: 9999 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        (year, month, day) =>
          JSON.stringify(parseTradingDate(tradingDate(year, month, day))) ===
          JSON.stringify({ year, month, day }),
      ),
    );
  });
});
