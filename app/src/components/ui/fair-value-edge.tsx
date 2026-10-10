/**
 * Fair value and edge display (P0-7, US-15): "Fair 41¢ · Edge −3¢ (cheap)".
 * Text plus color (never color alone). Shows when fair value is available.
 */

export type FairValueEdgeProps = {
  /** Market midpoint price in cents (1-99). */
  readonly marketPriceCents: number | null;
  /** Fair value in cents (1-99), or null if not available. */
  readonly fairValueCents: number | null;
};

/**
 * Displays fair value and edge: "Fair 41¢ · Edge −3¢ (cheap)" or "Fair 41¢ · Edge +3¢ (rich)".
 * Edge = market − fair (signed). Rich/cheap is always written, never only colored.
 * Returns null when fair value is not available.
 */
export function FairValueEdge({ marketPriceCents, fairValueCents }: FairValueEdgeProps) {
  if (fairValueCents === null || marketPriceCents === null) return null;

  const edge = marketPriceCents - fairValueCents;
  const edgeText = edge > 0 ? `+${edge}¢` : `${edge}¢`;
  const label = edge > 0 ? "rich" : edge < 0 ? "cheap" : "fair";
  const color =
    edge > 0 ? "text-mer-warn" : edge < 0 ? "text-mer-yes" : "text-mer-ink-muted";

  return (
    <span className="inline-flex items-center gap-mer-1 text-mer-sm" data-testid="fair-value-edge">
      <span className="mer-num text-mer-ink-muted">Fair {fairValueCents}¢</span>
      <span className="text-mer-ink-muted">·</span>
      <span className={`mer-num ${color}`}>
        Edge {edgeText} ({label})
      </span>
    </span>
  );
}
