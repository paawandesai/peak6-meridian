/**
 * P1-5: Hook to extract MM exposure data from PortfolioModel for MMExposureBlock.
 * Pure transformation: takes the already-computed model.mm and reshapes it for the component.
 */
import type { PortfolioModel } from "./model";

export type StrikeExposure = {
  /** Strike price in cents. */
  readonly strikeCents: bigint;
  /** Net exposure: YES contracts minus NO contracts (signed integer). */
  readonly netContracts: number;
  /** Market address. */
  readonly marketAddress: string;
};

export type MMExposureData = {
  /** Net exposure per strike (YES - NO in contracts). */
  readonly strikeExposures: readonly StrikeExposure[];
  /** Count of open orders. */
  readonly openOrdersCount: number;
  /** Unsettled open-orders balance in USDC base units. */
  readonly unsettledBalanceBase: bigint;
};

/**
 * Extracts MM exposure data from the portfolio model.
 * Returns null when there are no open orders (component should not render).
 */
export function useMMExposure(model: PortfolioModel | null): MMExposureData | null {
  if (model === null || model.mm.openOrders === 0) {
    return null;
  }

  const strikeExposures: StrikeExposure[] = model.mm.strikes
    .filter((strike) => strike.net !== 0n) // Only show strikes with non-zero exposure
    .map((strike) => ({
      strikeCents: strike.market.strikeCents,
      netContracts: Number(strike.net), // Convert bigint to number for display
      marketAddress: strike.market.address,
    }))
    .sort((a, b) => Number(a.strikeCents - b.strikeCents)); // Sort by strike ascending

  return {
    strikeExposures,
    openOrdersCount: model.mm.openOrders,
    unsettledBalanceBase: model.mm.unsettledUsdc,
  };
}
