/**
 * Integer unit conversions (docs/domain.md § Units). Money is `bigint`, prices are whole cents
 * as `number` (1–99), strikes are cents as `bigint`. Nothing here rounds: every conversion that
 * could lose precision throws instead.
 */

/** Decimals of the test-USDC mint. */
export const USDC_DECIMALS = 6;
/** Base units in 1 USDC. */
export const BASE_UNITS_PER_USDC = 1_000_000n;
/** Base units of 1 cent: the cost of one contract at price 1¢. */
export const BASE_UNITS_PER_CENT = 10_000n;
/** Collateral behind one pair (1 YES + 1 NO), in base units. */
export const PAIR_COLLATERAL = BASE_UNITS_PER_USDC;
/** Lowest valid order price, cents. */
export const MIN_PRICE_CENTS = 1;
/** Highest valid order price, cents. */
export const MAX_PRICE_CENTS = 99;
/** Price of a full pair, cents: NO price = this − YES price. */
export const PAIR_PRICE_CENTS = 100;
/** Strikes are multiples of $10, i.e. of this many cents. */
export const STRIKE_STEP_CENTS = 1_000n;
/** Cents in a dollar. */
export const CENTS_PER_DOLLAR = 100n;
/** Oracle values carry 18 fractional digits; strike cents × this is the comparable value. */
export const STRIKE_CENTS_TO_SCALED = 10n ** 16n;

/** Error thrown by every conversion that would be inexact or out of range. */
export class UnitError extends Error {
  override readonly name = "UnitError";
}

function requireNonNegative(value: bigint, what: string): void {
  if (value < 0n) {
    throw new UnitError(`${what} must not be negative: ${value}`);
  }
}

function requireMultiple(value: bigint, step: bigint, what: string): void {
  if (value % step !== 0n) {
    throw new UnitError(`${what} must be a multiple of ${step}: ${value}`);
  }
}

/** True for an integer price in 1–99. */
export function isValidPriceCents(price: number): boolean {
  return Number.isInteger(price) && price >= MIN_PRICE_CENTS && price <= MAX_PRICE_CENTS;
}

/** The price, or a `UnitError` if it is not an integer in 1–99. */
export function assertPriceCents(price: number): number {
  if (!isValidPriceCents(price)) {
    throw new UnitError(`price must be an integer between 1 and 99 cents: ${price}`);
  }
  return price;
}

/** True for a whole number of contracts ≥ 1. */
export function isValidQty(qty: bigint): boolean {
  return qty >= 1n;
}

/** The quantity, or a `UnitError` if it is below 1. */
export function assertQty(qty: bigint): bigint {
  if (!isValidQty(qty)) {
    throw new UnitError(`quantity must be at least 1 contract: ${qty}`);
  }
  return qty;
}

/** Cents → USDC base units (× 10,000). */
export function centsToBaseUnits(cents: bigint): bigint {
  requireNonNegative(cents, "cents");
  return cents * BASE_UNITS_PER_CENT;
}

/** USDC base units → cents; throws unless the amount is a whole number of cents. */
export function baseUnitsToCents(baseUnits: bigint): bigint {
  requireNonNegative(baseUnits, "base units");
  requireMultiple(baseUnits, BASE_UNITS_PER_CENT, "base units");
  return baseUnits / BASE_UNITS_PER_CENT;
}

/** Cost of `qty` contracts at `priceCents`, in base units: p × 10,000 × qty. */
export function contractCost(priceCents: number, qty: bigint): bigint {
  return BigInt(assertPriceCents(priceCents)) * BASE_UNITS_PER_CENT * assertQty(qty);
}

/** Collateral for `qty` pairs, in base units: 1,000,000 × qty. */
export function pairCollateral(qty: bigint): bigint {
  requireNonNegative(qty, "pairs");
  return qty * PAIR_COLLATERAL;
}

/** NO price for a YES price (and vice versa): 100 − p. */
export function complementPriceCents(priceCents: number): number {
  return PAIR_PRICE_CENTS - assertPriceCents(priceCents);
}

/** Whole dollars → strike cents ($680 → 68,000). */
export function dollarsToStrikeCents(dollars: bigint): bigint {
  requireNonNegative(dollars, "dollars");
  return dollars * CENTS_PER_DOLLAR;
}

/** Strike cents → whole dollars; throws unless the strike is a whole number of dollars. */
export function strikeCentsToDollars(strikeCents: bigint): bigint {
  requireNonNegative(strikeCents, "strike cents");
  requireMultiple(strikeCents, CENTS_PER_DOLLAR, "strike cents");
  return strikeCents / CENTS_PER_DOLLAR;
}

/** True for a positive multiple of $10. */
export function isValidStrikeCents(strikeCents: bigint): boolean {
  return strikeCents > 0n && strikeCents % STRIKE_STEP_CENTS === 0n;
}

/** The strike, or a `UnitError` if it is not a positive multiple of $10. */
export function assertStrikeCents(strikeCents: bigint): bigint {
  if (!isValidStrikeCents(strikeCents)) {
    throw new UnitError(`strike must be a positive multiple of $10 in cents: ${strikeCents}`);
  }
  return strikeCents;
}

/** Strike cents on the oracle scale (18 fractional digits): cents × 10^16. */
export function strikeCentsToScaled(strikeCents: bigint): bigint {
  requireNonNegative(strikeCents, "strike cents");
  return strikeCents * STRIKE_CENTS_TO_SCALED;
}

/** The settlement rule: YES wins when the scaled close is at or above the strike, exactly. */
export function closesAtOrAbove(closeScaled: bigint, strikeCents: bigint): boolean {
  return closeScaled >= strikeCentsToScaled(strikeCents);
}

/** Base units → decimal string with exactly 6 fractional digits ("1.250000"). */
export function formatUsdc(baseUnits: bigint): string {
  requireNonNegative(baseUnits, "base units");
  const whole = baseUnits / BASE_UNITS_PER_USDC;
  const fraction = baseUnits % BASE_UNITS_PER_USDC;
  return `${whole}.${fraction.toString().padStart(USDC_DECIMALS, "0")}`;
}

const USDC_TEXT = /^(\d+)(?:\.(\d{1,6}))?$/;

/** Decimal string ("1.25") → base units, exactly; throws beyond 6 fractional digits. */
export function parseUsdc(text: string): bigint {
  const match = USDC_TEXT.exec(text.trim());
  if (match === null || match[1] === undefined) {
    throw new UnitError(`not a USDC amount with at most 6 decimals: ${JSON.stringify(text)}`);
  }
  const fraction = (match[2] ?? "").padEnd(USDC_DECIMALS, "0");
  return BigInt(match[1]) * BASE_UNITS_PER_USDC + BigInt(fraction);
}

/** `YYYYMMDD` for an ET calendar date; validates the calendar, not the exchange schedule. */
export function tradingDate(year: number, month: number, day: number): number {
  const valid =
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    year >= 1970 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month);
  if (!valid) {
    throw new UnitError(`not a calendar date: ${year}-${month}-${day}`);
  }
  return year * 10_000 + month * 100 + day;
}

/** The inverse of `tradingDate`. */
export function parseTradingDate(value: number): { year: number; month: number; day: number } {
  if (!Number.isInteger(value) || value < 19_700_101 || value > 99_991_231) {
    throw new UnitError(`not a YYYYMMDD trading date: ${value}`);
  }
  const year = Math.floor(value / 10_000);
  const month = Math.floor((value % 10_000) / 100);
  const day = value % 100;
  tradingDate(year, month, day);
  return { year, month, day };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// ---- display-only formatters (UI-02 AC6 / AC6b; OQ-15 approved) --------------------------------
// These are the only lossy or locale-style conversions in this file: they round DOWN (toward −∞
// for signed amounts) so a displayed figure never overstates a gain or understates a loss, and
// they never feed a transaction. `formatUsdc` / `parseUsdc` keep their exact, throwing behaviour.

const MINUS = "−";

export type SignMode = "auto" | "always";

/**
 * Settle price (18 fractional digits) → whole cents, rounding **down**. The one lossy conversion:
 * it floors because settlement is exact (`close_scaled >= strike_cents × 10^16`) and strikes are
 * whole cents, so a displayed price can never contradict the outcome ($179.996 settles NO and
 * shows $179.99, never $180.00). Throws on a negative.
 */
export function scaledToCentsFloor(scaled: bigint): bigint {
  if (scaled < 0n) throw new UnitError(`a settle price cannot be negative: ${scaled}`);
  return scaled / STRIKE_CENTS_TO_SCALED;
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
  if (perQty <= 0n) throw new UnitError(`quantity must be positive: ${perQty}`);
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
