/** Exact decimal-string to integer-cents conversion (domain.md § Units: no binary floats). */

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parses a non-negative decimal price ("230.12", "230.125", "230") into integer cents, rounding
 * fractional cents half up. Returns null for anything else (signs, exponents, empty, too large).
 */
export function parseDecimalToCents(text: string): number | null {
  const match = DECIMAL.exec(text);
  const whole = match?.[1];
  if (match === null || whole === undefined) {
    return null;
  }
  const fraction = (match[2] ?? "").padEnd(3, "0");
  // Half up on cents: round up iff the thousandths digit is ≥ 5 (later digits cannot matter).
  const roundUp = Number(fraction[2]) >= 5 ? 1n : 0n;
  const cents = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2)) + roundUp;
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}
