import {
  asOfSecs,
  edgeCents,
  edgeText,
  edgeTone,
  type EdgeTone,
  type FairValue,
  formatAge,
  type StaleReason,
  staleReasons,
} from "@/lib/fair-values";
import { formatEtDayHms } from "@/lib/time";

export type FairEdgeProps = {
  /** The displayed YES price in cents, or `null` when the book gives no tight price. */
  readonly yesCents: number | null;
  /** The service's value for this market; `undefined` when it has none. */
  readonly fair: FairValue | undefined;
  readonly status: "loading" | "ready" | "unavailable";
  /** When the app last read fair values successfully (unix seconds), `null` when it never has. */
  readonly lastSuccessSecs: number | null;
  readonly nowSecs: number;
};

const TONE_CLASS: Record<EdgeTone, string> = {
  yes: "text-mer-yes",
  no: "text-mer-no",
  neutral: "text-mer-ink-muted",
};

/** `Spot as of Fri 19:59:59 ET` (weekday only when not today, ET): information, not a verdict. */
export function spotAsOfText(asOf: number, nowSecs: number): string {
  return `Spot as of ${formatEtDayHms(asOf, nowSecs)} ET`;
}

function reasonText(reason: StaleReason): string {
  if (reason.kind === "server") return "the pricing service flagged it stale";
  return reason.secs === null
    ? "no update from the pricing service yet"
    : `no update from the pricing service for ${formatAge(reason.secs)}`;
}

/**
 * The fair value's detail (design.md § "Data staleness and time"): its spot time, then why it is
 * stale when it is, e.g. `Spot as of Fri 19:59:59 ET; the pricing service flagged it stale`.
 */
export function fairDetail(asOf: number, reasons: readonly StaleReason[], nowSecs: number): string {
  return [spotAsOfText(asOf, nowSecs), ...reasons.map(reasonText)].join("; ");
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

/** The `stale` tag: visible text, its reason on hover (`title`) and the same words for screen readers. */
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
 * rich / cheap / fair word is always written; colour never carries it. Staleness is the server's
 * `stale` flag or no successful read for 30 s (P0-FV); a stale value is still shown, muted with a
 * `stale` tag that says why. The spot time is on hover and for screen readers either way. Edge is
 * market − fair in integer cents. Nothing is invented when a number is missing.
 */
export function FairEdge({ yesCents, fair, status, lastSuccessSecs, nowSecs }: FairEdgeProps) {
  if (fair === undefined) {
    if (status === "loading") return <p role="status">Fair value loading…</p>;
    // No value for this strike: the caller says so in words where it has room (PriceFair).
    return null;
  }
  const reasons = staleReasons(fair, lastSuccessSecs, nowSecs);
  const stale = reasons.length > 0;
  const detail = fairDetail(asOfSecs(fair), reasons, nowSecs);
  return (
    <p
      className={`mer-num text-mer-md ${stale ? "text-mer-ink-muted" : ""}`}
      data-testid="fair-edge"
      data-stale={stale ? "true" : "false"}
      title={detail}
    >
      <span>Fair {fair.fair_cents}¢</span>
      {" · "}
      {yesCents === null ? (
        <span>Edge unavailable (no tight market price)</span>
      ) : (
        <EdgeLabel edge={edgeCents(yesCents, fair.fair_cents)} muted={stale} />
      )}
      {stale ? (
        <StaleTag detail={detail} />
      ) : (
        <span className="sr-only" data-testid="fair-spot">
          {`; ${detail}`}
        </span>
      )}
    </p>
  );
}
