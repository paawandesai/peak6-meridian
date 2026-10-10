/**
 * Vault invariant chip (P0-7, FR-29, US-19): displays "Vault = pairs × $1" with pass/fail.
 * Links to /status for the full invariant table. Visible on Trade to make the demo moment
 * (one screen: fills, book, fair value, distribution, vault invariant).
 */

import { formatUsdCents } from "@/lib/display";
import { formatEtHms } from "@/lib/time";

export type VaultInvariantProps = {
  /** Vault balance in USDC base units (6 decimals). */
  readonly vaultBalanceBaseUnits: bigint;
  /** Pairs outstanding (0 decimals). */
  readonly pairsOutstanding: bigint;
  /** Unix seconds of the data read. */
  readonly asOfSecs: number;
  /** Link to /status. */
  readonly statusHref?: string;
};

/**
 * Vault invariant: "Vault $1,240.00 = 1,240 pairs × $1.00 ✓ (as of 14:52:05 ET)".
 * Pass when `vault_balance === pairs_outstanding × 1_000_000` exactly (domain.md invariant 1).
 * Fail otherwise (should never happen; if it does, it's critical).
 */
export function VaultInvariantChip({
  vaultBalanceBaseUnits,
  pairsOutstanding,
  asOfSecs,
  statusHref = "/status",
}: VaultInvariantProps) {
  const vaultCents = vaultBalanceBaseUnits / 10_000n;
  const expectedBaseUnits = pairsOutstanding * 1_000_000n;
  const expectedCents = expectedBaseUnits / 10_000n;
  const pass = vaultBalanceBaseUnits === expectedBaseUnits;

  const vaultText = formatUsdCents(vaultCents);
  const expectedText = formatUsdCents(expectedCents);
  const symbol = pass ? "✓" : "✗";
  const color = pass ? "text-mer-gain" : "text-mer-loss";
  const asOf = formatEtHms(asOfSecs);

  return (
    <a
      href={statusHref}
      className={`inline-flex items-center gap-mer-1 rounded-mer border px-mer-2 py-mer-1 text-mer-sm ${
        pass ? "border-mer-gain/30 bg-mer-gain/10" : "border-mer-loss bg-mer-loss/10"
      } hover:underline`}
      data-testid="vault-invariant-chip"
    >
      <span className="mer-num">
        Vault {vaultText} = {pairsOutstanding.toLocaleString("en-US")} pairs × $1.00
      </span>
      <span className={`font-semibold ${color}`} aria-label={pass ? "Pass" : "Fail"}>
        {symbol}
      </span>
      <span className="text-mer-ink-muted">(as of {asOf} ET)</span>
    </a>
  );
}
