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
 * Validates that fault injection is only used on localnet (AC2). Returns the fault configuration
 * or throws if FAULT_INJECT_SOURCE is set on a non-local cluster.
 */
export function validateFaultInjection(): FaultConfig {
  const faultSource = process.env.FAULT_INJECT_SOURCE;
  const cluster = process.env.SOLANA_CLUSTER;

  if (faultSource !== undefined && cluster !== "localnet") {
    throw new Error(
      `FAULT_INJECT_SOURCE='${faultSource}' is refused on cluster '${cluster}': ` +
        "fault injection is only allowed on localnet (security: never against real services)",
    );
  }

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
