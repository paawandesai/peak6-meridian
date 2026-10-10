import { Countdown, StateBadge, TestMarketBadge } from "../ui";
import { FairEdge } from "../fair-value/fair-edge";
import type { BookQuotes } from "@meridian/client";
import {
  type BadgeContext,
  badgeProps,
  nextTransition,
  openCloseText,
  rangeText,
  yesView,
} from "@/lib/market-view";
import { formatStrike, isSessionMarket, marketStatus, type MarketRow } from "@/lib/markets";
import type { FairValue } from "@/lib/fair-values";
import type { OpenTime } from "@/lib/open-times-core";

/** What the page knows about one strike's book and fair value. */
export type StrikeData = {
  readonly quotes?: BookQuotes | null;
  /** Creation time (unix seconds), `null` when unknown, `"unavailable"` when unreadable (P1-4). */
  readonly openedAt: OpenTime;
  readonly fair?: FairValue;
  readonly fairStatus: "loading" | "ready" | "unavailable";
  readonly fairRefreshFailed: boolean;
};

function YesCell({ view }: { readonly view: ReturnType<typeof yesView> }) {
  if (view.kind === "mid") {
    return <span className="mer-num">{view.yes}¢</span>;
  }
  if (view.kind === "range") {
    return (
      <span className="mer-num">
        {rangeText(view.bid, view.ask)} <span className="text-mer-ink-muted">wide</span>
      </span>
    );
  }
  return <span aria-label="price not live yet">—</span>;
}

function NoCell({ view }: { readonly view: ReturnType<typeof yesView> }) {
  if (view.kind === "mid") return <span className="mer-num">{view.no}¢</span>;
  if (view.kind === "range") {
    return <span className="mer-num">{rangeText(view.noBid, view.noAsk)}</span>;
  }
  return <span>—</span>;
}

function ProbabilityCell({ view }: { readonly view: ReturnType<typeof yesView> }) {
  if (view.kind === "mid") {
    return <span className="mer-num">{view.probability}%</span>;
  }
  return <span className="text-mer-ink-muted">—</span>;
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
  const isTest = !isSessionMarket(market);
  return (
    <tr className="relative border-t border-mer-rule align-top">
      <td className="py-mer-2 pr-mer-3">
        <div className="flex items-center gap-mer-1">
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
          {isTest ? <TestMarketBadge /> : null}
        </div>
        <span className="block text-mer-xs text-mer-ink-muted sm:hidden">
          {openCloseText(data.openedAt, market.closeTs, !isTest)}
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
        <span className="block text-mer-xs text-mer-ink-muted">YES</span>
      </td>
      <td className="py-mer-2 pr-mer-3">
        <NoCell view={view} />
        <span className="block text-mer-xs text-mer-ink-muted">NO</span>
      </td>
      <td className="py-mer-2 pr-mer-3">
        <FairEdge
          yesCents={view.kind === "mid" ? view.yes : null}
          fair={data.fair}
          status={data.fairStatus}
          refreshFailed={data.fairRefreshFailed}
          nowSecs={ctx.nowSecs}
        />
      </td>
      <td className="hidden py-mer-2 pr-mer-3 sm:table-cell">
        <ProbabilityCell view={view} />
        <span className="block w-32">
          <Bar view={view} />
        </span>
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
        {openCloseText(data.openedAt, market.closeTs, !isTest)}
      </td>
      <td className="mer-num py-mer-2 text-right text-mer-ink-muted">
        {market.pairsOutstanding.toLocaleString("en-US")}
      </td>
    </tr>
  );
}
