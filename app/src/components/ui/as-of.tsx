/** Data older than this many seconds is labelled stale and muted (domain.md MM threshold). */
export const STALE_AFTER_SECS = 10;
/** Older than this, a banner warns before signing. */
export const BANNER_AFTER_SECS = 60;

/**
 * "as of 14:52:05 ET" with the staleness rule (design.md §3): older than 10 s gets a `stale`
 * label and a muted style; older than 60 s adds a banner. The caller passes the formatted time
 * and the age in whole seconds.
 */
export function AsOf({
  time,
  ageSecs,
}: {
  /** Already formatted `HH:mm:ss`. */
  readonly time: string;
  readonly ageSecs: number;
}) {
  const stale = ageSecs > STALE_AFTER_SECS;
  const minutes = Math.max(1, Math.floor(ageSecs / 60));
  return (
    <span className="inline-flex flex-col gap-mer-1">
      <span className={`text-mer-xs ${stale ? "text-mer-ink-muted italic" : "text-mer-ink-muted"}`}>
        as of {time} ET{stale ? " · stale" : ""}
      </span>
      {ageSecs > BANNER_AFTER_SECS ? (
        <span
          role="status"
          className="rounded-mer border border-mer-warn px-mer-2 py-mer-1 text-mer-sm text-mer-warn"
        >
          Prices are {minutes} min old. Trading still works; check the book before you sign.
        </span>
      ) : null}
    </span>
  );
}
