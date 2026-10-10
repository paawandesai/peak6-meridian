import { formatUsdSigned, strikeCentsToDollars } from "@meridian/client";
import { useState } from "react";

type StrikeExposure = {
  /** Strike price in cents. */
  readonly strikeCents: bigint;
  /** Net exposure: YES contracts minus NO contracts (signed integer). */
  readonly netContracts: number;
  /** Market address. */
  readonly marketAddress: string;
};

type MMExposureBlockProps = {
  /** Net exposure per strike (YES - NO in contracts). */
  readonly strikeExposures: readonly StrikeExposure[];
  /** Count of open orders. */
  readonly openOrdersCount: number;
  /** Unsettled open-orders balance in USDC base units. */
  readonly unsettledBalanceBase: bigint;
};

/**
 * MM (P3 Market Maker) exposure block for Portfolio page (P1-5).
 * Shows:
 * - Net exposure per strike (YES minus NO, in contracts)
 * - Open orders count
 * - Unsettled open-orders balance
 * Dense tabular layout, collapsed when no open orders.
 * Uses integer/bigint money via packages/client helpers only.
 */
export function MMExposureBlock({
  strikeExposures,
  openOrdersCount,
  unsettledBalanceBase,
}: MMExposureBlockProps) {
  const [isExpanded, setIsExpanded] = useState(openOrdersCount > 0);

  // Don't show if no open orders
  if (openOrdersCount === 0) {
    return null;
  }

  const unsettledDisplay = formatUsdSigned(unsettledBalanceBase);

  return (
    <div className="border-t border-mer-rule bg-mer-surface px-mer-4 py-mer-3">
      <details open={isExpanded} onToggle={(e) => setIsExpanded((e.target as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer text-mer-sm font-mer-medium text-mer-ink">
          MM Exposure
          <span className="ml-mer-2 text-mer-xs font-normal text-mer-ink-muted">
            {openOrdersCount} open {openOrdersCount === 1 ? "order" : "orders"} · {unsettledDisplay} unsettled
          </span>
        </summary>

        <div className="mt-mer-3">
          {strikeExposures.length > 0 ? (
            <table className="w-full text-mer-xs">
              <thead>
                <tr className="border-b border-mer-rule text-left text-mer-ink-muted">
                  <th className="pb-mer-1 font-mer-medium">Strike</th>
                  <th className="pb-mer-1 text-right font-mer-medium">Net</th>
                </tr>
              </thead>
              <tbody>
                {strikeExposures.map((exposure) => {
                  const strikeDisplay = strikeCentsToDollars(exposure.strikeCents);
                  const isLong = exposure.netContracts > 0;
                  const isShort = exposure.netContracts < 0;

                  return (
                    <tr key={exposure.marketAddress} className="border-b border-mer-rule/50">
                      <td className="py-mer-1 text-mer-ink">${strikeDisplay}</td>
                      <td
                        className={`
                          py-mer-1 text-right font-mer-mono
                          ${isLong ? "text-mer-gain" : isShort ? "text-mer-loss" : "text-mer-ink-muted"}
                        `}
                      >
                        {isLong ? "+" : ""}
                        {exposure.netContracts}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="text-mer-xs text-mer-ink-muted">No net exposure</p>
          )}
        </div>
      </details>
    </div>
  );
}
