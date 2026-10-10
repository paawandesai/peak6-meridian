import { edgeCents, edgeText, type FairValue, isStale } from "@/lib/fair-values";

export type FairEdgeProps = {
  /** The displayed YES price in cents, or `null` when the book gives no tight price. */
  readonly yesCents: number | null;
  /** The service's value for this market; `undefined` when it has none. */
  readonly fair: FairValue | undefined;
  readonly status: "loading" | "ready" | "unavailable";
  /** The last refresh failed, so whatever is shown is the last good value. */
  readonly refreshFailed: boolean;
  readonly nowSecs: number;
};

/**
 * `Fair 58¢ · Edge +4¢ (rich)` (design.md § "Price, probability, fair value, edge"). The
 * rich / cheap / fair word is always written; colour never carries it. A stale value says so in
 * text. Edge is market − fair in integer cents. Nothing is invented when a number is missing.
 */
export function FairEdge({ yesCents, fair, status, refreshFailed, nowSecs }: FairEdgeProps) {
  if (status === "loading") return <p role="status">Fair value loading…</p>;
  if (fair === undefined) {
    // When fair values unavailable (503), probability already shown in Probability column
    return null;
  }
  const stale = refreshFailed || isStale(fair, nowSecs);
  return (
    <p className="mer-num text-mer-md" data-testid="fair-edge">
      <span>Fair {fair.fair_cents}¢</span>
      {" · "}
      <span>
        {yesCents === null
          ? "Edge unavailable (no tight market price)"
          : edgeText(edgeCents(yesCents, fair.fair_cents))}
      </span>
      {stale ? (
        <span className="ml-mer-2 text-mer-xs italic text-mer-ink-muted"> · stale</span>
      ) : null}
    </p>
  );
}
