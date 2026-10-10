/**
 * Pyth live price display with freshness indicator (M3-10, D-055).
 *
 * Shows the Pyth quote price, confidence, and age with visual staleness indicator.
 * Pyth Pro is the primary demo price source per D-055.
 */

import { formatUsdCents } from "@/lib/display";
import { formatEtHms } from "@/lib/time";
import { isPythQuoteStale, formatQuoteAge, type PythQuote } from "@/lib/pyth-quotes";

export function PythPrice({
  quote,
  nowMs,
}: {
  readonly quote: PythQuote;
  /** Current time in milliseconds. */
  readonly nowMs: number;
}) {
  const priceCents = BigInt(quote.price_cents);
  const confCents = BigInt(quote.conf_cents);
  const publishTimeSecs = quote.publish_time;
  const stale = isPythQuoteStale(publishTimeSecs, nowMs);
  const age = formatQuoteAge(publishTimeSecs, nowMs);

  return (
    <span className="flex flex-wrap items-baseline gap-x-mer-2">
      <span className="mer-num text-mer-md font-medium">
        {formatUsdCents(priceCents)}
        {confCents > 0n ? (
          <span className="text-mer-xs text-mer-ink-muted"> ±{formatUsdCents(confCents)}</span>
        ) : null}
      </span>
      <span
        className={`text-mer-xs ${stale ? "text-mer-warn italic" : "text-mer-ink-muted"}`}
        title={`Published ${formatEtHms(publishTimeSecs)} ET`}
      >
        {stale ? "stale · " : ""}
        {age}
      </span>
      <span className="rounded-mer bg-mer-pyth px-mer-2 py-1 text-mer-xs font-medium text-white">
        Pyth
      </span>
    </span>
  );
}

/**
 * Placeholder shown when Pyth quote is loading.
 */
export function PythPricePlaceholder() {
  return (
    <span className="flex flex-wrap items-baseline gap-x-mer-2">
      <span className="text-mer-sm text-mer-ink-muted">Pyth price loading</span>
    </span>
  );
}

/**
 * Error message when Pyth quote is unavailable.
 */
export function PythPriceUnavailable({ ticker }: { readonly ticker: string }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-mer-2">
      <span className="text-mer-sm text-mer-ink-muted">{ticker} price unavailable</span>
    </span>
  );
}
