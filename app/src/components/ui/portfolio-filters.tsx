/**
 * Portfolio filters and totals line (P0-6 FR-19).
 * Three tabs: Open / Resting orders / Closed
 * Totals: USDC balance, redeemable now, unrealized P&L
 */

export type FilterTab = "open" | "resting" | "closed";

export type PortfolioTotals = {
  /** USDC balance in base units (6 decimals). */
  readonly usdcBalance: bigint;
  /** Amount redeemable from settled markets (USDC base units). */
  readonly redeemableNow: bigint;
  /** Unrealized P&L in cents (can be negative). */
  readonly unrealizedCents: bigint;
};

export type PortfolioFiltersProps = {
  readonly activeTab: FilterTab;
  readonly onTabChange: (tab: FilterTab) => void;
  readonly totals: PortfolioTotals;
};

/**
 * Format USDC from base units to dollar string.
 * E.g., 1_000_000n → "$1.00"
 */
function formatUSDC(baseUnits: bigint): string {
  const dollars = Number(baseUnits) / 1_000_000;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Format P&L cents to dollar string with sign.
 * E.g., 12345n → "+$123.45", -500n → "-$5.00"
 */
function formatPnL(cents: bigint): string {
  const dollars = Number(cents) / 100;
  const formatted = Math.abs(dollars).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (cents > 0n) return `+$${formatted}`;
  if (cents < 0n) return `-$${formatted}`;
  return `$${formatted}`;
}

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
      <div className="flex flex-wrap items-baseline gap-x-mer-4 gap-y-mer-2 text-mer-sm">
        <div>
          <span className="text-mer-ink-muted">USDC: </span>
          <span className="font-semibold">{formatUSDC(totals.usdcBalance)}</span>
        </div>
        <div>
          <span className="text-mer-ink-muted">Redeemable: </span>
          <span className="font-semibold">{formatUSDC(totals.redeemableNow)}</span>
        </div>
        <div>
          <span className="text-mer-ink-muted">Unrealized: </span>
          <span
            className={`font-semibold ${totals.unrealizedCents > 0n ? "text-mer-gain" : totals.unrealizedCents < 0n ? "text-mer-loss" : ""}`}
          >
            {formatPnL(totals.unrealizedCents)}
          </span>
        </div>
      </div>

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
    </div>
  );
}
