import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseDecimalToCents } from "../src/money";

describe("parseDecimalToCents", () => {
  it.each([
    ["230", 23_000],
    ["230.1", 23_010],
    ["230.12", 23_012],
    ["230.12000", 23_012],
    ["230.124", 23_012],
    ["230.12499", 23_012],
    ["230.125", 23_013],
    ["0.005", 1],
    ["0.004", 0],
    ["99.995", 10_000],
  ])("%s → %d cents (halves up)", (text, cents) => {
    expect(parseDecimalToCents(text)).toBe(cents);
  });

  it.each(["", "-1.00", "+1", "1e3", "1.", ".5", "abc", "1,000.00", " 1", "99999999999999999"])(
    "rejects %j",
    (text) => {
      expect(parseDecimalToCents(text)).toBeNull();
    },
  );

  it("round-trips any integer cents written with 2–6 decimals", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e12 }), fc.nat(4), (cents, extraZeros) => {
        const text = `${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, "0")}${"0".repeat(extraZeros)}`;
        expect(parseDecimalToCents(text)).toBe(cents);
      }),
    );
  });

  it("rounds half up against a bigint reference", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), (millis) => {
        const text = `${String(millis / 1000n)}.${String(millis % 1000n).padStart(3, "0")}`;
        expect(parseDecimalToCents(text)).toBe(Number((millis + 5n) / 10n));
      }),
    );
  });
});
