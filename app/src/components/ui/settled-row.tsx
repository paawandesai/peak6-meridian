/**
 * Settled market row for Portfolio (US-11, P0-6).
 * Shows settle price in dollars, outcome, $1.00/$0.00 per side, and one-click Redeem.
 */
import type { MarketRow } from "@/lib/markets";

export type SettledRowProps = {
  readonly market: MarketRow;
  /** Text for the one-click redeem button. */
  readonly redeemLabel: string;
  /** Called when the user clicks Redeem. The view builds the full transaction. */
  readonly onRedeem: () => void;
  /** True while a redeem transaction is in flight. */
  readonly busy?: boolean;
};

/**
 * Format settle price from 18-decimal scaled bigint to dollar string.
 * E.g., 681_230_000_000_000_000_000n → "$681.23"
 */
function formatSettlePrice(scaled: bigint): string {
  const dollars = Number(scaled) / 1e18;
  return `$${dollars.toFixed(2)}`;
}

/**
 * Get the winning and losing payouts per contract.
 * Always $1.00 for winners, $0.00 for losers.
 */
function payouts(outcome: "Yes" | "No"): { yes: string; no: string } {
  if (outcome === "Yes") return { yes: "$1.00", no: "$0.00" };
  return { yes: "$0.00", no: "$1.00" };
}

/**
 * Oracle source text per domain.md: Pyth Pro with RedStone cross-check (D-054/D-055).
 */
const ORACLE_SOURCE = "Pyth Pro, RedStone cross-check";

export function SettledRow({ market, redeemLabel, onRedeem, busy = false }: SettledRowProps) {
  if (!market.settled || market.outcome === "None") {
    throw new Error("SettledRow requires a settled market with outcome Yes or No");
  }

  const settlePrice = formatSettlePrice(market.settlePriceScaled);
  const outcome = market.outcome; // "Yes" or "No"
  const { yes, no } = payouts(outcome);

  return (
    <div
      className="grid gap-mer-2 rounded-mer border border-mer-control-border bg-mer-surface p-mer-3"
      data-testid="settled-row"
    >
      <div className="flex items-baseline justify-between gap-mer-2">
        <div className="text-mer-md font-semibold">
          Settled {outcome} at {settlePrice}
        </div>
        <button
          type="button"
          onClick={onRedeem}
          disabled={busy}
          className="rounded-mer bg-mer-ink px-mer-3 py-mer-2 text-mer-sm font-semibold text-mer-paper disabled:opacity-50"
          data-testid="redeem-button"
        >
          {busy ? "Redeeming…" : redeemLabel}
        </button>
      </div>
      <div className="text-mer-sm text-mer-ink-muted">
        {ORACLE_SOURCE} · {yes} / {no} per side
      </div>
    </div>
  );
}
