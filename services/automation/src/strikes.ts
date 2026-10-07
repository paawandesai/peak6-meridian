/**
 * Strike ladder for one ticker (domain.md § Strike algorithm).
 *
 * All arithmetic is exact integer math on cents (bigint inside), never binary floats.
 */

/** Percent offsets from the previous close, in ascending order. */
export const STRIKE_OFFSETS_PCT: readonly number[] = [-9, -6, -3, 0, 3, 6, 9];

/** Strikes are multiples of $10 = 1,000 cents. */
export const STRIKE_STEP_CENTS = 1_000;

/** Largest accepted close: keeps every strike (≤ 1.09 × P + $5) a safe integer. */
export const MAX_PREV_CLOSE_CENTS = Math.floor(Number.MAX_SAFE_INTEGER / 2);

/**
 * Strikes for a previous official close.
 *
 * @param prevCloseCents previous trading day's official close P, in integer cents
 *   (1..MAX_PREV_CLOSE_CENTS).
 * @returns strikes in integer cents: multiples of 1,000, > 0, unique, ascending (at most 7).
 * @throws RangeError if `prevCloseCents` is not an integer in that range.
 */
export function computeStrikes(prevCloseCents: number): number[] {
  if (
    !Number.isSafeInteger(prevCloseCents) ||
    prevCloseCents <= 0 ||
    prevCloseCents > MAX_PREV_CLOSE_CENTS
  ) {
    throw new RangeError(
      `computeStrikes: previous close must be an integer number of cents in 1..${String(MAX_PREV_CLOSE_CENTS)}, got ${String(prevCloseCents)}`,
    );
  }
  const strikes = new Set<number>();
  for (const pct of STRIKE_OFFSETS_PCT) {
    const strike = roundToStrike(BigInt(prevCloseCents), pct);
    if (strike > 0) {
      strikes.add(strike);
    }
  }
  return [...strikes].sort((a, b) => a - b);
}

/**
 * raw = P × (1 + pct/100); strike = floor(raw / $10 + 0.5) × $10 (halves up).
 *
 * In cents: raw = P × (100 + pct) / 100 and raw / 1,000 = P × (100 + pct) / 100,000,
 * so floor(x + 0.5) = floor((2·num + den) / (2·den)) with num ≥ 0, den > 0.
 */
function roundToStrike(prevCloseCents: bigint, pct: number): number {
  const num = prevCloseCents * BigInt(100 + pct);
  const den = 100n * BigInt(STRIKE_STEP_CENTS);
  const steps = (2n * num + den) / (2n * den);
  return Number(steps * BigInt(STRIKE_STEP_CENTS));
}
