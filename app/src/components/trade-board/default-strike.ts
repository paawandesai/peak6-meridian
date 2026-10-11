/**
 * Which strike the detail view selects (docs/redesign-spec.md §2.3). Pure, integer-only: strikes
 * and the live price are integer cents.
 */

/**
 * The index of the strike at or just above the live price in an ascending list: the smallest
 * strike ≥ live, the highest strike when live is above them all, the middle one when there is no
 * live price, and `-1` for an empty list.
 */
export function defaultStrikeIndex(strikes: readonly bigint[], live: bigint | null): number {
  if (strikes.length === 0) return -1;
  if (live === null) return Math.floor((strikes.length - 1) / 2);
  const above = strikes.findIndex((strike) => strike >= live);
  return above === -1 ? strikes.length - 1 : above;
}

/**
 * The selected market of an ascending ladder: the one whose address is `selected` when it is on
 * the ladder, otherwise the default from the live price. `null` only for an empty ladder.
 */
export function resolveSelectedStrike<
  T extends { readonly address: string; readonly strikeCents: bigint },
>(ladder: readonly T[], selected: string | null, live: bigint | null): T | null {
  const chosen = selected === null ? undefined : ladder.find((m) => m.address === selected);
  if (chosen !== undefined) return chosen;
  return (
    ladder[
      defaultStrikeIndex(
        ladder.map((m) => m.strikeCents),
        live,
      )
    ] ?? null
  );
}
