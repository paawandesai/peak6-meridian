/**
 * Portfolio filters and totals line (P0-6 FR-19).
 * Three tabs: Open / Resting orders / Closed
 * Totals: USDC balance, redeemable now, unrealized P&L, realized P&L
 */

import { formatUsdSigned, formatUsdcBalance } from "@meridian/client";

export type FilterTab = "open" | "resting" | "closed";

export type PortfolioTotals = {
  /** USDC balance in base units (6 decimals). */
  readonly usdcBalance: bigint | null;
  /** Amount redeemable from settled markets (USDC base units). */
  readonly redeemableNow: bigint;
  /** Unrealized P&L in USDC base units (can be negative). Name is legacy. */
  readonly unrealizedCents: bigint;
  /** Realized P&L in USDC base units (can be negative). */
  readonly realizedCents: bigint;
};

export type PortfolioFiltersProps = {
  readonly activeTab: FilterTab;
  readonly onTabChange: (tab: FilterTab) => void;
  readonly totals: PortfolioTotals;
};

const TAB_LABELS: Record<FilterTab, string> = {
  open: "Open",
  resting: "Resting orders",
  closed: "Closed",
};

export function PortfolioFilters({ activeTab, onTabChange, totals }: PortfolioFiltersProps) {
  const tabs: FilterTab[] = ["open", "resting", "closed"];

  return (
    <div className="grid gap-mer-3" data-testid="portfolio-filters">
      {/* Totals line */}
      <p className="flex flex-wrap items-center gap-x-mer-4 gap-y-mer-1" aria-label="Totals">
        <span className="mer-num">
          {totals.usdcBalance === null ? "test-USDC —" : formatUsdcBalance(totals.usdcBalance)}
        </span>
        <span>
          Redeemable now <span className="mer-num">{formatUsdSigned(totals.redeemableNow)}</span>
        </span>
        <span>
          Unrealized{" "}
          <span
            className={`mer-num ${totals.unrealizedCents > 0n ? "text-mer-gain" : totals.unrealizedCents < 0n ? "text-mer-loss" : ""}`}
          >
            {formatUsdSigned(totals.unrealizedCents, "always")}
          </span>
        </span>
        <span>
          Realized{" "}
          <span
            className={`mer-num ${totals.realizedCents > 0n ? "text-mer-gain" : totals.realizedCents < 0n ? "text-mer-loss" : ""}`}
          >
            {formatUsdSigned(totals.realizedCents, "always")}
          </span>
        </span>
      </p>

      {/* Filter tabs */}
      <div role="tablist" className="flex gap-mer-2">
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            onClick={() => onTabChange(tab)}
            className={`rounded-mer px-mer-3 py-mer-2 text-mer-sm font-semibold ${
              activeTab === tab
                ? "bg-mer-ink text-mer-paper"
                : "bg-mer-surface text-mer-ink hover:bg-mer-control-border"
            }`}
          >
            {TAB_LABELS[tab]}
          </button>
        ))}
      </div>
      <p className="text-mer-xs text-mer-ink-muted">
        Mark is the book midpoint, not a guaranteed sale price.
      </p>
    </div>
  );
}
