import { formatStrike, type MarketRow } from "@/lib/markets";

export type StrikeSelectorProps = {
  readonly ticker: string;
  /** Ascending strike: the primary close set. */
  readonly strikes: readonly MarketRow[];
  /** Address of the selected market. */
  readonly selected: string | null;
  readonly onSelect: (market: string) => void;
};

/**
 * One option per strike as a native radio group (arrow keys move the choice, Tab leaves the
 * group), drawn as a row of chips. The selected chip is filled, and its radio is checked for
 * screen readers.
 */
export function StrikeSelector({ ticker, strikes, selected, onSelect }: StrikeSelectorProps) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-mer-1 text-mer-sm text-mer-ink-muted">Strike</legend>
      <div className="flex flex-wrap gap-mer-1">
        {strikes.map((market) => {
          const checked = market.address === selected;
          return (
            <label
              key={market.address}
              className={`mer-num inline-flex min-h-9 cursor-pointer items-center rounded-mer border px-mer-2 text-mer-sm has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-mer-focus ${
                checked
                  ? "border-mer-ink bg-mer-ink font-semibold text-mer-paper"
                  : "border-mer-control-border"
              }`}
            >
              <input
                type="radio"
                name={`strike-${ticker}`}
                value={market.address}
                checked={checked}
                onChange={() => onSelect(market.address)}
                className="sr-only"
              />
              {formatStrike(market.strikeCents)}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
