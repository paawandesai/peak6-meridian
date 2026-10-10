/**
 * RedStone oracle integration types (M2-16)
 */

/**
 * RedStone gateway historical response format.
 * Gateways return pre-built payloads with all signatures included.
 */
export interface RedstoneHistoricalResponse {
  /** Feed ID (32-byte hex string) */
  readonly id: string;
  /** Close timestamp in milliseconds */
  readonly timestampMilliseconds: number;
  /** Complete RedStone payload bytes (hex-encoded) */
  readonly payload: string;
  /** Median value from the package (8 decimals, per RedStone format) */
  readonly value: number;
}

/** RedStone gateway client config */
export interface RedstoneGatewayConfig {
  readonly gateways: string[]; // At least 2
  readonly dataServiceId: string; // "redstone-primary-prod"
  readonly maxPackageDelaySecs: number;
  readonly requiredSigners: number; // At least 3 (validated on-chain)
  readonly timeoutMs: number;
}

/** Official close from external source (Tiingo/Twelve Data) */
export interface OfficialClose {
  source: "tiingo" | "twelve-data";
  symbol: string;
  tradingDate: number; // YYYYMMDD
  closeCents: number;
}

/** Cross-check result */
export interface CrossCheckResult {
  passed: boolean;
  redstoneValueCents: number;
  tiingoCloseCents: number;
  twelveDataCloseCents: number;
  tiingoBps: number; // Deviation in basis points
  twelveDataBps: number;
}
