/** YES / NO with hue and the full word, never colour alone (design.md §3 "YES vs NO"). */
export function SideLabel({
  side,
  meaning,
}: {
  readonly side: "YES" | "NO";
  /** One line of meaning on first use per page, e.g. "pays $1.00 if NVDA closes at or above $180". */
  readonly meaning?: string;
}) {
  const hue = side === "YES" ? "text-mer-yes border-mer-yes" : "text-mer-no border-mer-no";
  return (
    <span className="inline-flex flex-col">
      <span
        className={`inline-flex w-fit items-center rounded-mer border px-mer-2 text-mer-sm font-semibold ${hue}`}
      >
        {side}
      </span>
      {meaning === undefined ? null : (
        <span className="text-mer-xs text-mer-ink-muted">{meaning}</span>
      )}
    </span>
  );
}
