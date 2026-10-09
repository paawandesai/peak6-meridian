import { Countdown, StateBadge } from "../ui";
import type { BookQuotes } from "@meridian/client";
import {
  type BadgeContext,
  badgeProps,
  nextTransition,
  openCloseText,
  rangeText,
  yesView,
} from "@/lib/market-view";
import { formatStrike, marketStatus, type MarketRow } from "@/lib/markets";

/** What the page knows about one strike's book: quotes, or `undefined` while not live. */
export type StrikeData = { readonly quotes?: BookQuotes | null; readonly openedAt: number | null };

function YesCell({ view }: { readonly view: ReturnType<typeof yesView> }) {
  if (view.kind === "mid") {
    return (
      <span className="mer-num">
        {view.yes}¢ YES · {view.probability}%
      </span>
    );
  }
  if (view.kind === "range") {
    return (
      <span className="mer-num">
        {rangeText(view.bid, view.ask)} YES <span className="text-mer-ink-muted">wide spread</span>
      </span>
    );
  }
  return <span aria-label="price not live yet">—</span>;
}

function NoCell({ view }: { readonly view: ReturnType<typeof yesView> }) {
  if (view.kind === "mid") return <span className="mer-num">{view.no}¢ NO</span>;
  if (view.kind === "range") {
    return <span className="mer-num">{rangeText(view.noBid, view.noAsk)} NO</span>;
  }
  return <span>—</span>;
}

/** The probability bar: filled to the YES price, or an outlined bid-to-ask segment for a range. */
function Bar({ view }: { readonly view: ReturnType<typeof yesView> }) {
  return (
    <span aria-hidden="true" className="relative block h-2 w-full rounded-mer bg-mer-rule/60">
      {view.kind === "mid" ? (
        <span
          data-testid="bar-fill"
          className="absolute inset-y-0 left-0 rounded-mer bg-mer-yes"
          style={{ width: `${view.yes}%` }}
        />
      ) : null}
      {view.kind === "range" && view.bid !== null && view.ask !== null ? (
        <span
          data-testid="bar-range"
          className="absolute inset-y-0 rounded-mer border border-mer-yes"
          style={{ left: `${view.bid}%`, width: `${Math.max(1, view.ask - view.bid)}%` }}
        />
      ) : null}
    </span>
  );
}

/**
 * One strike (a table row). The row link is an anchor in the strike cell stretched over the row
 * with CSS, never a link on the `tr`; it renders only when `tradeHref` is supplied.
 */
export function StrikeRow({
  market,
  data,
  ctx,
  tradeHref,
  markerBelow,
  markerAbove,
}: {
  readonly market: MarketRow;
  readonly data: StrikeData;
  readonly ctx: BadgeContext;
  readonly tradeHref?: ((market: MarketRow) => string) | undefined;
  /** The live-price line falls just below this strike's row (between it and the next strike). */
  readonly markerBelow: boolean;
  readonly markerAbove: boolean;
}) {
  const status = marketStatus(market, ctx.nowSecs);
  const view = yesView(data.quotes);
  const transition = nextTransition(market, status, ctx.nowSecs, ctx.overrideDelaySecs);
  const strike = formatStrike(market.strikeCents);
  return (
    <tr className="relative border-t border-mer-rule align-top">
      <td className="py-mer-2 pr-mer-3">
        {tradeHref === undefined ? (
          <span className="mer-num font-medium">{strike}</span>
        ) : (
          <a
            href={tradeHref(market)}
            className="mer-num font-medium underline-offset-4 after:absolute after:inset-0 hover:underline"
          >
            {strike} <span className="font-normal text-mer-ink-muted">Trade</span>
          </a>
        )}
        <span className="block text-mer-xs text-mer-ink-muted sm:hidden">
          {openCloseText(data.openedAt, market.closeTs)}
        </span>
        {markerAbove ? (
          <span
            aria-hidden="true"
            data-testid="live-marker"
            className="pointer-events-none absolute inset-x-0 top-0 border-t-2 border-dashed border-mer-warn"
          />
        ) : null}
        {markerBelow ? (
          <span
            aria-hidden="true"
            data-testid="live-marker"
            className="pointer-events-none absolute inset-x-0 bottom-0 border-b-2 border-dashed border-mer-warn"
          />
        ) : null}
      </td>
      <td className="py-mer-2 pr-mer-3">
        <YesCell view={view} />
      </td>
      <td className="py-mer-2 pr-mer-3">
        <NoCell view={view} />
        <span className="block text-mer-xs text-mer-ink-muted">
          NO is 100 − YES; YES + NO = 100¢
        </span>
      </td>
      <td className="hidden w-32 py-mer-2 pr-mer-3 sm:table-cell">
        <Bar view={view} />
      </td>
      <td className="py-mer-2 pr-mer-3">
        <StateBadge {...badgeProps(market, status, ctx)} />
        {transition === null ? null : (
          <span className="mt-mer-1 block text-mer-xs text-mer-ink-muted">
            <Countdown label={transition.label} secondsLeft={transition.secondsLeft} />
          </span>
        )}
      </td>
      <td className="hidden py-mer-2 pr-mer-3 text-mer-xs text-mer-ink-muted sm:table-cell">
        {openCloseText(data.openedAt, market.closeTs)}
      </td>
      <td className="mer-num py-mer-2 text-right text-mer-ink-muted">
        {market.pairsOutstanding.toLocaleString("en-US")}
      </td>
    </tr>
  );
}
