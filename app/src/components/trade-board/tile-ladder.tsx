import { EdgeLabel, StaleTag, fairDetail } from "@/components/fair-value/fair-edge";
import { asOfSecs, edgeCents, staleReasons } from "@/lib/fair-values";
import { formatStrike } from "@/lib/markets";
import { rangeText, yesView, type YesView } from "@/lib/market-view";
import type { FairMeta, StrikeCell } from "./types";

/** Shown under a tile's table when no strike has a quote (same words as the Markets ladder). */
export const NO_QUOTES_TEXT = "No quotes yet: odds appear when the market maker posts.";

function YesCell({ view }: { readonly view: YesView }) {
  if (view.kind === "mid") return <span className="mer-num">{view.yes}¢</span>;
  if (view.kind === "range") {
    return (
      <span className="mer-num">
        {rangeText(view.bid, view.ask)} <span className="text-mer-ink-muted">wide</span>
      </span>
    );
  }
  return <span aria-label="price not live yet">—</span>;
}

/** Blank cell with its reason for screen readers only. */
function Missing({ reason }: { readonly reason: string }) {
  return (
    <span className="text-mer-ink-muted">
      <span aria-hidden="true">—</span>
      <span className="sr-only">{reason}</span>
    </span>
  );
}

function FairAndEdgeCells({
  view,
  cell,
  fairMeta,
  nowSecs,
}: {
  readonly view: YesView;
  readonly cell: StrikeCell;
  readonly fairMeta: FairMeta;
  readonly nowSecs: number;
}) {
  const { fair } = cell;
  if (fair === undefined) {
    const loading = fairMeta.status === "loading";
    return (
      <>
        <td className="py-mer-1 pr-mer-2" data-testid="fair-cell">
          {loading ? (
            <span className="text-mer-ink-muted">
              <span aria-hidden="true">…</span>
              <span className="sr-only">Fair value loading</span>
            </span>
          ) : (
            <Missing reason="no fair value" />
          )}
        </td>
        <td className="py-mer-1" data-testid="edge-cell">
          <Missing reason="no edge without a fair value" />
        </td>
      </>
    );
  }
  const reasons = staleReasons(fair, fairMeta.lastSuccessSecs, nowSecs);
  const stale = reasons.length > 0;
  const detail = fairDetail(asOfSecs(fair), reasons, nowSecs);
  return (
    <>
      <td
        className={`py-mer-1 pr-mer-2 ${stale ? "text-mer-ink-muted" : ""}`}
        data-testid="fair-cell"
        data-stale={stale ? "true" : "false"}
        title={detail}
      >
        <span className="mer-num">{fair.fair_cents}¢</span>
        {stale ? <StaleTag detail={detail} /> : null}
      </td>
      <td className="py-mer-1" data-testid="edge-cell">
        {view.kind === "mid" ? (
          <EdgeLabel edge={edgeCents(view.yes, fair.fair_cents)} muted={stale} />
        ) : (
          <Missing reason="no edge without a tight market price" />
        )}
      </td>
    </>
  );
}

/** The live-price line on a row's top or bottom edge: decorative, never a table row. */
function LiveMarker({ edge }: { readonly edge: "top" | "bottom" }) {
  return (
    <span
      aria-hidden="true"
      data-testid="live-marker"
      className={`pointer-events-none absolute inset-x-0 border-dashed border-mer-warn ${edge === "top" ? "top-0 border-t-2" : "bottom-0 border-b-2"}`}
    />
  );
}

/**
 * A tile's compact strike ladder (docs/redesign-spec.md §2.2): Strike · YES · Fair · Edge, one row
 * per shown strike. Each row is one button stretched over the row (a `tr` cannot be a control)
 * that opens the detail view at that strike. YES follows the displayed-price rule; edge is shown
 * only against a midpoint, with its rich/cheap word always written.
 */
export function TileLadder({
  ticker,
  rows,
  markerAfter,
  hidden,
  fairMeta,
  nowSecs,
  onSelectMarket,
  onShowMore,
}: {
  readonly ticker: string;
  /** Ascending strike. */
  readonly rows: readonly StrikeCell[];
  /** The live line's position: after this row, -1 above the first, `null` for none. */
  readonly markerAfter: number | null;
  /** Open strikes not shown here. */
  readonly hidden: number;
  readonly fairMeta: FairMeta;
  readonly nowSecs: number;
  readonly onSelectMarket: (market: string) => void;
  readonly onShowMore: () => void;
}) {
  const anyQuote = rows.some((cell) => yesView(cell.quotes).kind !== "none");
  return (
    <div className="grid gap-mer-2">
      <table className="w-full text-mer-sm">
        <caption className="sr-only">{ticker} strikes</caption>
        <thead>
          <tr className="text-left text-mer-xs text-mer-ink-muted">
            <th scope="col" className="py-mer-1 pr-mer-2 font-medium">
              Strike
            </th>
            <th scope="col" className="py-mer-1 pr-mer-2 font-medium">
              YES
            </th>
            <th scope="col" className="py-mer-1 pr-mer-2 font-medium">
              Fair
            </th>
            <th scope="col" className="py-mer-1 font-medium">
              Edge
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((cell, i) => {
            const view = yesView(cell.quotes);
            const strike = formatStrike(cell.market.strikeCents);
            return (
              <tr
                key={cell.market.address}
                className="relative border-t border-mer-rule hover:bg-mer-surface"
              >
                <td className="py-mer-1 pr-mer-2">
                  <button
                    type="button"
                    onClick={() => onSelectMarket(cell.market.address)}
                    aria-label={`${ticker} ${strike}: open details`}
                    className="mer-num font-medium after:absolute after:inset-0"
                  >
                    {strike}
                  </button>
                  {markerAfter === -1 && i === 0 ? <LiveMarker edge="top" /> : null}
                  {markerAfter === i ? <LiveMarker edge="bottom" /> : null}
                </td>
                <td className="py-mer-1 pr-mer-2">
                  <YesCell view={view} />
                </td>
                <FairAndEdgeCells view={view} cell={cell} fairMeta={fairMeta} nowSecs={nowSecs} />
              </tr>
            );
          })}
        </tbody>
      </table>
      {!anyQuote ? <p className="text-mer-xs text-mer-ink-muted">{NO_QUOTES_TEXT}</p> : null}
      {hidden > 0 ? (
        <button
          type="button"
          onClick={onShowMore}
          className="justify-self-start text-mer-sm text-mer-ink-muted underline-offset-4 hover:underline"
        >
          +{hidden} more {hidden === 1 ? "strike" : "strikes"}
        </button>
      ) : null}
    </div>
  );
}
