import {
  ageSecs,
  asOfSecs,
  edgeCents,
  edgeText,
  edgeTone,
  type EdgeTone,
  type FairValue,
  formatAge,
  isStale,
} from "@/lib/fair-values";
import { formatEtHms } from "@/lib/time";

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

const TONE_CLASS: Record<EdgeTone, string> = {
  yes: "text-mer-yes",
  no: "text-mer-no",
  neutral: "text-mer-ink-muted",
};

/**
 * `Fair value as of 14:52:05 ET, 42 s old` (design.md § "Data staleness and time"). A failed
 * refresh is said too, because then the age alone understates why the value is old.
 */
export function staleDetail(asOf: number, nowSecs: number, refreshFailed = false): string {
  const failed = refreshFailed ? "; the last refresh failed" : "";
  return `Fair value as of ${formatEtHms(asOf)} ET, ${formatAge(ageSecs(asOf, nowSecs))} old${failed}`;
}

/**
 * `Edge +4¢ (rich)`, colour-coded by side: cheap in the YES colour, rich in the NO colour. The
 * word is always written, so colour never carries the meaning on its own.
 */
export function EdgeLabel({
  edge,
  muted = false,
}: {
  readonly edge: number;
  readonly muted?: boolean;
}) {
  return (
    <span
      className={`mer-num font-semibold ${muted ? "text-mer-ink-muted" : TONE_CLASS[edgeTone(edge)]}`}
      data-testid="edge"
      data-tone={edgeTone(edge)}
    >
      {edgeText(edge)}
    </span>
  );
}

/** The `stale` tag: visible text, its age on hover (`title`) and the same words for screen readers. */
export function StaleTag({ detail }: { readonly detail: string }) {
  return (
    <span
      className="ml-mer-1 inline-block rounded-mer border border-mer-warn px-1 text-mer-xs font-normal text-mer-warn"
      title={detail}
      data-testid="stale-tag"
    >
      stale<span className="sr-only">: {detail}</span>
    </span>
  );
}

/**
 * `Fair 58¢ · Edge +4¢ (rich)` (design.md § "Price, probability, fair value, edge"). The
 * rich / cheap / fair word is always written; colour never carries it. A stale value is still
 * shown, muted with a `stale` tag that gives its age. Edge is market − fair in integer cents.
 * Nothing is invented when a number is missing.
 */
export function FairEdge({ yesCents, fair, status, refreshFailed, nowSecs }: FairEdgeProps) {
  if (fair === undefined) {
    if (status === "loading") return <p role="status">Fair value loading…</p>;
    // No value for this strike: the caller says so in words where it has room (PriceFair).
    return null;
  }
  const stale = refreshFailed || isStale(fair, nowSecs);
  return (
    <p
      className={`mer-num text-mer-md ${stale ? "text-mer-ink-muted" : ""}`}
      data-testid="fair-edge"
      data-stale={stale ? "true" : "false"}
    >
      <span>Fair {fair.fair_cents}¢</span>
      {" · "}
      {yesCents === null ? (
        <span>Edge unavailable (no tight market price)</span>
      ) : (
        <EdgeLabel edge={edgeCents(yesCents, fair.fair_cents)} muted={stale} />
      )}
      {stale ? <StaleTag detail={staleDetail(asOfSecs(fair), nowSecs, refreshFailed)} /> : null}
    </p>
  );
}
