/**
 * Test market toggle (P0-1): a disclosure control that shows/hides non-session markets.
 * Session markets (closing at the NYSE session close) are always visible. Test markets
 * (created with `--close-in-secs`) are hidden by default behind "Show test markets (N)".
 */

export type TestMarketToggleProps = {
  readonly testMarketCount: number;
  readonly showTestMarkets: boolean;
  readonly onToggle: () => void;
};

/**
 * "Show test markets (N)" disclosure button. Hidden when there are no test markets to show.
 */
export function TestMarketToggle({
  testMarketCount,
  showTestMarkets,
  onToggle,
}: TestMarketToggleProps) {
  if (testMarketCount === 0) return null;

  return (
    <button
      type="button"
      onClick={onToggle}
      className="text-mer-sm text-mer-ink-muted underline-offset-4 hover:underline"
      data-testid="test-market-toggle"
    >
      {showTestMarkets ? "Hide" : "Show"} test markets ({testMarketCount})
    </button>
  );
}

/**
 * TEST badge for non-session markets when shown. Text plus color (never color alone).
 */
export function TestMarketBadge() {
  return (
    <span
      className="inline-flex items-center rounded-mer bg-mer-warn/10 px-mer-1 py-0.5 text-mer-xs font-semibold text-mer-warn"
      data-testid="test-market-badge"
    >
      TEST
    </span>
  );
}
