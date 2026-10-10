import { formatStrike } from "@/lib/markets";
import type { MarketRow } from "@/lib/markets";

type CompactStrikeRowProps = {
  readonly market: MarketRow;
  /** YES price in cents (midpoint or bid/ask). */
  readonly yesPriceCents: number;
  /** Fair value in cents, null if unavailable. */
  readonly fairValueCents: number | null;
  /** Edge in cents (yesPriceCents - fairValueCents), null if fair value unavailable. */
  readonly edgeCents: number | null;
  /** Handler for row click (navigate to /trade/[market]). */
  readonly onClick?: () => void;
};

/**
 * Compact one-line strike row for mobile Markets ladder (P0-3).
 * Shows: strike · YES · NO = 100−YES · implied % · probability bar · fair/edge chip.
 * Uses only packages/client unit helpers for money formatting.
 */
export function CompactStrikeRow({
  market,
  yesPriceCents,
  fairValueCents,
  edgeCents,
  onClick,
}: CompactStrikeRowProps) {
  const noPriceCents = 100 - yesPriceCents;
  const impliedPercent = yesPriceCents;

  return (
    <div className="border-b border-mer-rule">
      <button
        onClick={onClick}
        className="w-full px-mer-3 py-mer-2 text-left hover:bg-mer-surface-hover"
      >
        <div className="flex items-center justify-between gap-mer-2">
        {/* Strike */}
        <div className="flex-shrink-0 font-mer-medium text-mer-sm text-mer-ink">
          {formatStrike(market.strikeCents)}
        </div>

        {/* YES · NO · Implied % */}
        <div className="flex flex-1 items-center gap-mer-2 text-mer-xs">
          <span className="text-mer-yes">{yesPriceCents}¢</span>
          <span className="text-mer-ink-muted">·</span>
          <span className="text-mer-no">{noPriceCents}¢</span>
          <span className="text-mer-ink-muted">·</span>
          <span className="text-mer-ink-muted">{impliedPercent}%</span>
        </div>

        {/* Probability bar */}
        <div className="h-2 w-16 flex-shrink-0 overflow-hidden rounded-full bg-mer-surface">
          <div
            className="h-full bg-mer-yes"
            style={{ width: `${impliedPercent}%` }}
            aria-label={`${impliedPercent}% probability`}
          />
        </div>

        {/* Fair/Edge chip */}
        {fairValueCents !== null && edgeCents !== null && (
          <div
            className={`
              flex-shrink-0 rounded-mer px-mer-1.5 py-mer-0.5 text-mer-xs
              ${edgeCents > 0 ? "bg-mer-gain/10 text-mer-gain" : edgeCents < 0 ? "bg-mer-loss/10 text-mer-loss" : "bg-mer-surface text-mer-ink-muted"}
            `}
          >
            {edgeCents > 0 ? "+" : ""}
            {edgeCents}¢
          </div>
        )}
        </div>
      </button>
    </div>
  );
}

type LivePriceMarkerProps = {
  /** Current live price in dollars. */
  readonly priceDollars: number;
  /** Price timestamp for "as of" display. */
  readonly priceAsOf: number;
};

/**
 * Live price marker row shown between strikes on the ladder (P0-3).
 * Displays the current price with an indicator line and "as of" time.
 */
export function LivePriceMarker({ priceDollars, priceAsOf }: LivePriceMarkerProps) {
  const asOfTime = new Date(priceAsOf * 1000).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  return (
    <div className="flex items-center gap-mer-2 border-b border-mer-primary bg-mer-primary/5 px-mer-3 py-mer-1.5">
      <div className="h-0.5 flex-1 bg-mer-primary" />
      <div className="flex items-center gap-mer-1.5 text-mer-xs">
        <span className="font-mer-medium text-mer-primary">
          ${priceDollars.toFixed(2)}
        </span>
        <span className="text-mer-ink-muted">as of {asOfTime}</span>
      </div>
      <div className="h-0.5 flex-1 bg-mer-primary" />
    </div>
  );
}
