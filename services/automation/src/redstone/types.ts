/**
 * RedStone oracle integration types (M2-16)
 */

/** RedStone gateway response for a data package */
export interface RedstoneDataPackage {
  timestampMilliseconds: number;
  signature: string;
  dataPoints: Array<{
    dataFeedId: string;
    value: number;
  }>;
  signerAddress: string;
}

/** RedStone gateway client config */
export interface RedstoneGatewayConfig {
  gateways: string[]; // At least 2
  dataServiceId: string; // "redstone-primary-prod"
  maxPackageDelaySecs: number;
  requiredSigners: number; // At least 3
  timeoutMs: number;
}

/** Official close from external source (Tiingo/Twelve Data) */
export interface OfficialClose {
  source: 'tiingo' | 'twelve-data';
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
