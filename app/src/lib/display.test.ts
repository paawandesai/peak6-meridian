import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  formatPriceTenths,
  formatUsdcBalance,
  formatUsdCents,
  formatUsdSigned,
  scaledToCentsFloor,
} from "./display";

const SCALED_PER_CENT = 10n ** 16n;
const MINUS = "−";

/** Parses `$1,250.00` / `−$1.20` / `+$3.80` back to cents. */
function parseUsd(text: string): bigint {
  const negative = text.startsWith(MINUS);
  const digits = text.replace(/[^0-9.]/g, "");
  const [dollars = "0", fraction = "00"] = digits.split(".");
  const cents = BigInt(dollars) * 100n + BigInt(fraction);
  return negative ? -cents : cents;
}

describe("scaledToCentsFloor", () => {
  it("is exact at multiples of 10^16 and rounds down between", () => {
    expect(scaledToCentsFloor(0n)).toBe(0n);
    expect(scaledToCentsFloor(SCALED_PER_CENT)).toBe(1n);
    expect(scaledToCentsFloor(SCALED_PER_CENT - 1n)).toBe(0n);
    expect(scaledToCentsFloor(179_996_000_000_000_000_000n)).toBe(17_999n); // $179.99
    expect(scaledToCentsFloor(180_004_000_000_000_000_000n)).toBe(18_000n); // $180.00
  });

  it("rejects negatives", () => {
    expect(() => scaledToCentsFloor(-1n)).toThrow(RangeError);
  });

  it("is monotonic and round-trips with strike scaling (property)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 24n }),
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        (a, d) => {
          expect(scaledToCentsFloor(a + d)).toBeGreaterThanOrEqual(scaledToCentsFloor(a));
        },
      ),
    );
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 9n }), (cents) => {
        expect(scaledToCentsFloor(cents * SCALED_PER_CENT)).toBe(cents);
      }),
    );
  });

  it("closing at or above a whole-cent strike iff the floored price is at or above it (property)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 22n }),
        fc.bigInt({ min: 1n, max: 10n ** 6n }),
        (scaled, strikeCents) => {
          expect(scaled >= strikeCents * SCALED_PER_CENT).toBe(
            scaledToCentsFloor(scaled) >= strikeCents,
          );
        },
      ),
    );
  });
});

describe("formatUsdCents", () => {
  it("formats grouping, zero and the minus sign", () => {
    expect(formatUsdCents(18_142n)).toBe("$181.42");
    expect(formatUsdCents(125_000n)).toBe("$1,250.00");
    expect(formatUsdCents(0n)).toBe("$0.00");
    expect(formatUsdCents(5n)).toBe("$0.05");
    expect(formatUsdCents(-120n)).toBe(`${MINUS}$1.20`);
  });

  it("'always' prints the sign of non-zero amounts only", () => {
    expect(formatUsdCents(380n, "always")).toBe("+$3.80");
    expect(formatUsdCents(-120n, "always")).toBe(`${MINUS}$1.20`);
    expect(formatUsdCents(0n, "always")).toBe("$0.00");
  });

  it("parses back to the same cents for any bigint, including above MAX_SAFE_INTEGER (property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }), (cents) => {
        expect(parseUsd(formatUsdCents(cents))).toBe(cents);
        expect(parseUsd(formatUsdCents(cents, "always"))).toBe(cents);
        expect(formatUsdCents(cents)).not.toContain("-");
      }),
    );
  });
});

describe("formatUsdcBalance", () => {
  it("rounds down to whole cents and carries the test- qualifier", () => {
    expect(formatUsdcBalance(1_250_000n)).toBe("1.25 test-USDC");
    expect(formatUsdcBalance(1_250_000_000n)).toBe("1,250.00 test-USDC");
    expect(formatUsdcBalance(1_259_999n)).toBe("1.25 test-USDC");
    expect(formatUsdcBalance(0n)).toBe("0.00 test-USDC");
  });

  it("never exceeds the input (property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 24n }), (base) => {
        const shown = parseUsd(formatUsdcBalance(base).replace(" test-USDC", ""));
        expect(shown * 10_000n).toBeLessThanOrEqual(base);
        expect(base - shown * 10_000n).toBeLessThan(10_000n);
      }),
    );
  });
});

describe("formatPriceTenths", () => {
  it("shows one decimal of a cent, rounded down, dropping a zero decimal", () => {
    expect(formatPriceTenths(420_000n)).toBe("42¢");
    expect(formatPriceTenths(425_000n)).toBe("42.5¢");
    expect(formatPriceTenths(429_999n)).toBe("42.9¢");
    expect(formatPriceTenths(1_190_000n, 2n)).toBe("59.5¢"); // average entry: total cost / qty
    expect(formatPriceTenths(0n)).toBe("0¢");
  });

  it("rejects a non-positive quantity", () => {
    expect(() => formatPriceTenths(1n, 0n)).toThrow(RangeError);
  });

  it("never overstates the price (property)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.bigInt({ min: 1n, max: 1_000n }),
        (base, qty) => {
          const text = formatPriceTenths(base, qty);
          const [whole = "0", decimal = "0"] = text.replace("¢", "").split(".");
          const tenths = BigInt(whole) * 10n + BigInt(decimal);
          expect(tenths * qty * 1_000n).toBeLessThanOrEqual(base);
        },
      ),
    );
  });
});

describe("formatUsdSigned", () => {
  it("floors toward minus infinity so a gain is never overstated and a loss never understated", () => {
    expect(formatUsdSigned(2_000n, "always")).toBe("$0.00"); // 0.2 cents floors to $0.00
    expect(formatUsdSigned(-1_204_900n)).toBe(`${MINUS}$1.21`); // -$1.2049
    expect(formatUsdSigned(1_204_900n, "always")).toBe("+$1.20");
    expect(formatUsdSigned(3_800_000n, "always")).toBe("+$3.80");
  });

  it("agrees with formatUsdCents on whole-cent inputs (property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }), (cents) => {
        expect(formatUsdSigned(cents * 10_000n, "always")).toBe(formatUsdCents(cents, "always"));
        expect(formatUsdSigned(cents * 10_000n)).toBe(formatUsdCents(cents));
      }),
    );
  });

  it("never overstates a gain or understates a loss (property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }), (base) => {
        expect(parseUsd(formatUsdSigned(base)) * 10_000n).toBeLessThanOrEqual(base);
      }),
    );
  });
});
