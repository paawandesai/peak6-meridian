/** A price in integer cents with its implied probability: `62¢ · 62%` (design.md §3). */
export function Cents({
  cents,
  showPercent = true,
}: {
  /** Integer cents, 1 to 99. */
  readonly cents: number;
  readonly showPercent?: boolean;
}) {
  if (!Number.isInteger(cents) || cents < 0 || cents > 100) {
    throw new RangeError(`price must be an integer number of cents: ${cents}`);
  }
  return (
    <span className="mer-num">
      {cents}¢{showPercent ? ` · ${cents}%` : ""}
    </span>
  );
}
