import Link from "next/link";

import { formatUsdcBalance } from "@/lib/display";
import { vaultInvariant } from "@/lib/status";
import { formatEtHms } from "@/lib/time";

export type VaultInvariantChipProps = {
  /** `Market.pairs_outstanding`; `null` when it could not be read. */
  readonly pairs: bigint | null;
  /** Vault USDC base units; `null` when the vault could not be read. */
  readonly balance: bigint | null;
  /** Unix seconds of the read; `null` while the first read is in flight. */
  readonly asOfSecs: number | null;
};

const PAIR_TEXT = "pairs × $1.00";

/**
 * The chip's sentence (FR-29, US-19): `Vault 1,240.00 test-USDC = 1,240 pairs × $1.00 ✓ Pass
 * (as of 14:52:05 ET)`. Money goes through the same formatter and invariant check as /status, so
 * the two pages always print the same figures and verdict. An unreadable side is a Fail in words.
 */
export function vaultChipText({ pairs, balance, asOfSecs }: VaultInvariantChipProps): string {
  if (asOfSecs === null) return "Vault invariant loading…";
  const asOf = `(as of ${formatEtHms(asOfSecs)} ET)`;
  if (pairs === null)
    return `Vault invariant unavailable: the market account could not be read ✕ Fail ${asOf}`;
  const pairsText = `${pairs.toLocaleString("en-US")} ${PAIR_TEXT}`;
  if (balance === null) return `Vault unavailable ≠ ${pairsText} ✕ Fail ${asOf}`;
  const { verdict } = vaultInvariant(pairs, balance);
  const vault = formatUsdcBalance(balance);
  return verdict === "Pass"
    ? `Vault ${vault} = ${pairsText} ✓ Pass ${asOf}`
    : `Vault ${vault} ≠ ${pairsText} ✕ Fail ${asOf}`;
}

/** The vault invariant chip on Trade, linking to /status for every market's row. */
export function VaultInvariantChip(props: VaultInvariantChipProps) {
  const loading = props.asOfSecs === null;
  const pass =
    !loading &&
    props.pairs !== null &&
    props.balance !== null &&
    vaultInvariant(props.pairs, props.balance).verdict === "Pass";
  const tone = loading ? "text-mer-ink-muted" : pass ? "text-mer-gain" : "text-mer-loss";
  return (
    <Link
      href="/status"
      data-testid="vault-chip"
      data-verdict={loading ? "loading" : pass ? "Pass" : "Fail"}
      title="Open /status: the vault invariant for every market"
      className={`mer-num inline-flex min-h-6 items-center rounded-mer border border-mer-control-border bg-mer-surface px-mer-2 py-mer-1 text-mer-xs font-medium underline-offset-2 hover:underline ${tone}`}
    >
      {vaultChipText(props)}
    </Link>
  );
}
