/**
 * Fault injection helpers for demo-ops (M3-07 AC2): FAULT_INJECT_SOURCE is refused unless the
 * cluster is localnet. The fault makes one source report a close 2% off (200 bps >> 5 bps
 * threshold), causing settlement to fail its confidence check.
 */

export const FAULT_INJECT_BPS = 200; // 2% off

export interface FaultConfig {
  readonly source: "tiingo" | "twelvedata" | undefined;
  readonly offsetBps: number;
}

/**
 * Validates FAULT_INJECT_SOURCE env var. Returns the fault configuration or throws.
 * Note: This only validates the env var itself. The cluster check (via assertCluster) must be
 * done by the caller before calling this function.
 */
export function validateFaultInjection(): FaultConfig {
  const faultSource = process.env.FAULT_INJECT_SOURCE;

  if (faultSource !== undefined && faultSource !== "tiingo" && faultSource !== "twelvedata") {
    throw new Error(
      `FAULT_INJECT_SOURCE='${faultSource}' is invalid: must be 'tiingo' or 'twelvedata'`,
    );
  }

  return {
    source: faultSource as "tiingo" | "twelvedata" | undefined,
    offsetBps: FAULT_INJECT_BPS,
  };
}

/**
 * Applies the fault offset to a price in cents. Used by the test oracle or fixture overrides.
 */
export function applyFaultOffset(priceCents: bigint, offsetBps: number): bigint {
  const offset = (priceCents * BigInt(offsetBps)) / 10000n;
  return priceCents + offset;
}
