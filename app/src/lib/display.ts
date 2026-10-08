/**
 * The single adapter for display-only money helpers (UI-02 AC6 / AC6b). Every money string in the
 * app comes from here, so components never format money themselves. These are pure `bigint`
 * functions; no float is involved anywhere.
 *
 * OQ-15 (docs/status.md): the ticket places these in `packages/client/src/units.ts`. Until that
 * exception is approved they live here with the same names and signatures; if approved, this file
 * becomes a re-export of `@meridian/client` and the tests move next to `units.ts`.
 */

/** Oracle values carry 18 fractional digits; one cent is this many scaled units (10^16). */
const SCALED_PER_CENT = 10n ** 16n;
const BASE_UNITS_PER_CENT = 10_000n;
const MINUS = "−";

export type SignMode = "auto" | "always";

/**
 * Settle price (18 fractional digits) → whole cents, rounding **down**. The one lossy conversion:
 * it floors because settlement is exact (`close_scaled >= strike_cents × 10^16`) and strikes are
 * whole cents, so a displayed price can never contradict the outcome ($179.996 settles NO and
 * shows $179.99, never $180.00). Throws on a negative.
 */
export function scaledToCentsFloor(scaled: bigint): bigint {
  if (scaled < 0n) throw new RangeError(`a settle price cannot be negative: ${scaled}`);
  return scaled / SCALED_PER_CENT;
}

/** `1234567` → `"1,234,567"`. */
function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Cents (signed, exact) → `$1,250.00`, `−$1.20`, or with `"always"` `+$3.80`. Zero is `$0.00`. */
export function formatUsdCents(cents: bigint, sign: SignMode = "auto"): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const body = `$${group((abs / 100n).toString())}.${(abs % 100n).toString().padStart(2, "0")}`;
  if (negative) return `${MINUS}${body}`;
  return sign === "always" && abs !== 0n ? `+${body}` : body;
}

/** Floor division toward −∞. */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

/** A test-USDC balance in base units → `1,250.00 test-USDC`, rounded down to whole cents. */
export function formatUsdcBalance(baseUnits: bigint): string {
  const cents = floorDiv(baseUnits < 0n ? 0n : baseUnits, BASE_UNITS_PER_CENT);
  return `${formatUsdCents(cents).slice(1)} test-USDC`;
}

/**
 * A per-contract price in base units to one decimal of a cent, rounded down, a zero decimal
 * dropped: `42¢`, `42.5¢`. Average entry passes `(total_cost, qty)`.
 */
export function formatPriceTenths(baseUnits: bigint, perQty: bigint = 1n): string {
  if (perQty <= 0n) throw new RangeError(`quantity must be positive: ${perQty}`);
  const tenths = floorDiv(baseUnits * 10n, perQty * BASE_UNITS_PER_CENT);
  const whole = tenths / 10n;
  const decimal = tenths % 10n;
  return decimal === 0n ? `${whole}¢` : `${whole}.${decimal}¢`;
}

/**
 * Base units → dollars and cents like `formatUsdCents`, floored toward −∞ to the cent, so a gain
 * is never overstated and a loss never understated (`−$1.2049` shows `−$1.21`).
 */
export function formatUsdSigned(baseUnits: bigint, sign: SignMode = "auto"): string {
  return formatUsdCents(floorDiv(baseUnits, BASE_UNITS_PER_CENT), sign);
}
