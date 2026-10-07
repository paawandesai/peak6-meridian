/** Switchboard values carry 18 fractional digits (domain.md § Units). */
export const SCALE_DIGITS = 18;
const SCALE = 10n ** BigInt(SCALE_DIGITS);
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Exact decimal text (or a finite JSON number) → integer scaled by 10^18. Throws on anything
 * else, including exponents and more than 18 fractional digits; never rounds.
 */
export function toScaled18(value: string | number): bigint {
  const text = typeof value === "number" ? numberText(value) : value.trim();
  const match = DECIMAL.exec(text);
  if (match === null) throw new Error(`not a decimal: ${JSON.stringify(text)}`);
  const [, sign = "", whole = "0", fraction = ""] = match;
  if (fraction.length > SCALE_DIGITS) {
    throw new Error(`more than ${SCALE_DIGITS} fractional digits: ${text}`);
  }
  const magnitude = BigInt(whole) * SCALE + BigInt(fraction.padEnd(SCALE_DIGITS, "0"));
  return sign === "-" ? -magnitude : magnitude;
}

/** A JSON number as the shortest decimal text that round-trips (what the API sent). */
function numberText(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`not a finite number: ${value}`);
  const text = String(value);
  if (/e/i.test(text)) throw new Error(`number needs an exponent: ${text}`);
  return text;
}

/** Integer scaled by 10^18 → decimal text without trailing zeros. */
export function formatScaled18(scaled: bigint): string {
  const sign = scaled < 0n ? "-" : "";
  const magnitude = scaled < 0n ? -scaled : scaled;
  const whole = magnitude / SCALE;
  const fraction = (magnitude % SCALE).toString().padStart(SCALE_DIGITS, "0").replace(/0+$/, "");
  return `${sign}${whole}${fraction.length > 0 ? `.${fraction}` : ""}`;
}

/** Median of scaled values (mean of the middle two for an even count, truncated). */
export function median(values: readonly bigint[]): bigint {
  if (values.length === 0) throw new Error("median of no values");
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0n;
  if (sorted.length % 2 === 1) return upper;
  return ((sorted[mid - 1] ?? 0n) + upper) / 2n;
}

/**
 * Settlement rule 4 (domain.md): two positive values agree if they differ by at most `maxBps`
 * basis points of their mean, i.e. |a − b| × 2 × 10,000 ≤ maxBps × (a + b). Exact integers.
 */
export function withinSpread(a: bigint, b: bigint, maxBps: bigint): boolean {
  if (a <= 0n || b <= 0n) return false;
  const diff = a > b ? a - b : b - a;
  return diff * 2n * 10_000n <= maxBps * (a + b);
}

/** Spread between two positive values in hundredths of a basis point of their mean (truncated). */
export function spreadCentiBps(a: bigint, b: bigint): bigint {
  if (a <= 0n || b <= 0n) throw new Error("spread needs two positive values");
  const diff = a > b ? a - b : b - a;
  return (diff * 2n * 10_000n * 100n) / (a + b);
}
