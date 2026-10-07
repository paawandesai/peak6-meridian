import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { formatScaled18, median, spreadCentiBps, toScaled18, withinSpread } from "./decimal";

const E16 = 10n ** 16n;
const E18 = 10n ** 18n;

describe("toScaled18", () => {
  it("parses decimal text and JSON numbers exactly", () => {
    expect(toScaled18("254.43")).toBe(25_443n * E16);
    expect(toScaled18(254.43)).toBe(25_443n * E16);
    expect(toScaled18("0.000000000000000001")).toBe(1n);
    expect(toScaled18(" -1.5 ")).toBe(-15n * 10n ** 17n);
    expect(toScaled18("7")).toBe(7n * E18);
  });

  it.each(["", "abc", "1e3", "1.", ".5", "1.0000000000000000001", "1,5"])("rejects %j", (text) => {
    expect(() => toScaled18(text)).toThrow();
  });

  it("rejects non-finite numbers and numbers that need an exponent", () => {
    expect(() => toScaled18(Number.NaN)).toThrow(/finite/);
    expect(() => toScaled18(1e21)).toThrow(/exponent/);
  });

  it("matches the settlement comparison close_scaled ≥ strike_cents × 10^16 (property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 9n }), (cents) => {
        const text = `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
        expect(toScaled18(text)).toBe(cents * E16);
      }),
    );
  });
});

describe("formatScaled18", () => {
  it("drops trailing zeros", () => {
    expect(formatScaled18(25_443n * E16)).toBe("254.43");
    expect(formatScaled18(7n * E18)).toBe("7");
    expect(formatScaled18(-1n)).toBe("-0.000000000000000001");
  });

  it("round-trips with toScaled18 (property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }), (scaled) => {
        expect(toScaled18(formatScaled18(scaled))).toBe(scaled);
      }),
    );
  });
});

describe("median", () => {
  it("takes the middle value or the truncated mean of the middle two", () => {
    expect(median([3n, 1n, 2n])).toBe(2n);
    expect(median([4n, 1n, 2n, 3n])).toBe(2n);
    expect(() => median([])).toThrow();
  });

  it("lies between min and max (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt(), { minLength: 1, maxLength: 9 }), (values) => {
        const m = median(values);
        const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        expect(m >= (sorted[0] ?? 0n) && m <= (sorted.at(-1) ?? 0n)).toBe(true);
      }),
    );
  });
});

describe("withinSpread (domain.md settlement rule 4)", () => {
  it("accepts exactly 5 bps of the mean and rejects just above", () => {
    // mean 10,000.0025; 5 bps of it = 5.00000125; a − b = 5.0 → inside.
    expect(withinSpread(toScaled18("10002.5025"), toScaled18("9997.5025"), 5n)).toBe(true);
    expect(withinSpread(toScaled18("10002.51"), toScaled18("9997.49"), 5n)).toBe(false);
    expect(withinSpread(0n, 1n, 5n)).toBe(false);
  });

  it("is symmetric and always accepts equal values (property)", () => {
    const positive = fc.bigInt({ min: 1n, max: 10n ** 24n });
    fc.assert(
      fc.property(positive, positive, (a, b) => {
        expect(withinSpread(a, b, 5n)).toBe(withinSpread(b, a, 5n));
        expect(withinSpread(a, a, 0n)).toBe(true);
        if (withinSpread(a, b, 5n)) expect(spreadCentiBps(a, b) <= 500n).toBe(true);
      }),
    );
  });

  it("spreadCentiBps needs positive values", () => {
    expect(() => spreadCentiBps(0n, 1n)).toThrow();
  });
});
