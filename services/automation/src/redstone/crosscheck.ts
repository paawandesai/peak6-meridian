/**
 * Official-close cross-check (M2-16 AC2)
 * Verify RedStone value within 5 bps of both Tiingo and Twelve Data
 */

import type { OfficialClose, CrossCheckResult } from "./types.js";

const MAX_DEVIATION_BPS = 5;

/**
 * Calculate basis points deviation (integer arithmetic)
 */
function bpsDeviation(value: number, reference: number): number {
  if (reference === 0) return Infinity;
  // |value - reference| * 10000 / reference
  const diff = Math.abs(value - reference);
  return Math.floor((diff * 10000) / reference);
}

/**
 * Cross-check RedStone value against official closes (M2-16 AC2)
 */
export function crossCheckOfficialClose(
  redstoneValueCents: number,
  tiingoClose: OfficialClose,
  twelveDataClose: OfficialClose,
  tradingDate: number,
): CrossCheckResult {
  // Verify bar dates match trading date
  if (tiingoClose.tradingDate !== tradingDate) {
    throw new Error(`Tiingo bar date ${tiingoClose.tradingDate} !== trading date ${tradingDate}`);
  }
  if (twelveDataClose.tradingDate !== tradingDate) {
    throw new Error(
      `Twelve Data bar date ${twelveDataClose.tradingDate} !== trading date ${tradingDate}`,
    );
  }

  const tiingoBps = bpsDeviation(redstoneValueCents, tiingoClose.closeCents);
  const twelveDataBps = bpsDeviation(redstoneValueCents, twelveDataClose.closeCents);

  const passed = tiingoBps <= MAX_DEVIATION_BPS && twelveDataBps <= MAX_DEVIATION_BPS;

  return {
    passed,
    redstoneValueCents,
    tiingoCloseCents: tiingoClose.closeCents,
    twelveDataCloseCents: twelveDataClose.closeCents,
    tiingoBps,
    twelveDataBps,
  };
}
