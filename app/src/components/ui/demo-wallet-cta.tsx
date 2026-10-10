/**
 * Demo wallet CTA and fund toast (P0-6 US-01, FR-23).
 * Shows "Try the demo wallet (devnet)" button when no wallet connected.
 * Shows toast "+1,000 test-USDC" after auto-fund.
 */

export type DemoWalletCTAProps = {
  /** Called when user clicks the CTA button. */
  readonly onConnect: () => void;
  /** True while connecting. */
  readonly connecting?: boolean;
};

export type FundToastProps = {
  /** Amount funded in USDC base units (6 decimals). */
  readonly amountFunded: bigint;
  /** Called when user dismisses the toast. */
  readonly onDismiss: () => void;
};

/**
 * Format USDC from base units to display string.
 * E.g., 1_000_000_000n → "1,000"
 */
function formatUSDCAmount(baseUnits: bigint): string {
  const dollars = Number(baseUnits) / 1_000_000;
  return dollars.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function DemoWalletCTA({ onConnect, connecting = false }: DemoWalletCTAProps) {
  return (
    <button
      type="button"
      onClick={onConnect}
      disabled={connecting}
      className="rounded-mer bg-mer-ink px-mer-4 py-mer-3 text-mer-md font-semibold text-mer-paper disabled:opacity-50"
      data-testid="demo-wallet-cta"
    >
      {connecting ? "Connecting…" : "Try the demo wallet (devnet)"}
    </button>
  );
}

export function FundToast({ amountFunded, onDismiss }: FundToastProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-between gap-mer-4 rounded-mer border border-mer-gain bg-mer-surface p-mer-3"
      data-testid="fund-toast"
    >
      <div className="flex items-center gap-mer-2">
        <span className="text-mer-lg text-mer-gain" aria-hidden="true">
          ✓
        </span>
        <span className="text-mer-md font-semibold text-mer-gain">
          +{formatUSDCAmount(amountFunded)} test-USDC
        </span>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-mer-sm text-mer-ink-muted hover:text-mer-ink"
      >
        ✕
        </button>
    </div>
  );
}
