"use client";

import { useReader } from "./reader-context";
import { StateBadge } from "./ui";
import { useAsync } from "./use-async";
import { useNow } from "./use-now";
import { badgeProps } from "@/lib/market-view";
import {
  formatStrike,
  groupByTicker,
  isSessionMarket,
  marketStatus,
  type MarketRow,
} from "@/lib/markets";
import { formatCalendarDate } from "@/lib/demo-session";
import { defaultReplayParam, marketAsOf, REPLAY_PARAM, replayParamFor } from "@/lib/replay";

export const REPLAY_HONESTY_NOTE =
  "What replay can show: the session's markets, each market's state at this time (from its " +
  "on-chain close and settlement times) and the final on-chain result. It cannot show the order " +
  "book or prices at this time: the chain keeps only the current book and Meridian stores no " +
  "intraday history, so no historical prices are shown. Trading is off in replay.";

/**
 * The small replay control on the Markets page: a GET form, so choosing a time is a plain
 * navigation to `/?replay=...` (and Exit is a plain link back to `/`).
 */
export function ReplayControl({
  activeAtSecs,
  nowSecs,
}: {
  readonly activeAtSecs: number | null;
  readonly nowSecs: number;
}) {
  return (
    <form
      method="get"
      action="/"
      aria-label="Replay a past session"
      className="flex flex-wrap items-center gap-mer-2 text-mer-sm"
    >
      <label htmlFor="replay-at" className="font-medium">
        Replay a past session (read-only)
      </label>
      <input
        id="replay-at"
        type="datetime-local"
        name={REPLAY_PARAM}
        required
        defaultValue={
          activeAtSecs === null ? defaultReplayParam(nowSecs) : replayParamFor(activeAtSecs)
        }
        className="rounded-mer border border-mer-control-border bg-mer-surface px-mer-2 py-mer-1"
      />
      <span className="text-mer-xs text-mer-ink-muted">ET</span>
      <button
        type="submit"
        className="rounded-mer border border-mer-control-border px-mer-3 py-mer-1 font-medium"
      >
        View replay
      </button>
      {activeAtSecs === null ? null : (
        <a href="/" className="underline underline-offset-4">
          Back to live
        </a>
      )}
    </form>
  );
}

function ReplayTickerTable({
  ticker,
  markets,
  atSecs,
  nowSecs,
  overrideDelaySecs,
}: {
  readonly ticker: string;
  readonly markets: readonly MarketRow[];
  readonly atSecs: number;
  readonly nowSecs: number;
  readonly overrideDelaySecs: bigint;
}) {
  const then = { nowSecs: atSecs, paused: false, overrideDelaySecs };
  const today = { nowSecs, paused: false, overrideDelaySecs };
  return (
    <section aria-label={`${ticker} replay`}>
      <h2 className="mb-mer-2 text-mer-lg font-semibold">{ticker}</h2>
      <table className="w-full text-mer-sm">
        <thead>
          <tr className="text-left text-mer-ink-muted">
            <th className="py-mer-1 pr-mer-3 font-medium">Strike</th>
            <th className="py-mer-1 pr-mer-3 font-medium">State at replay time</th>
            <th className="py-mer-1 pr-mer-3 font-medium">Final on-chain result</th>
          </tr>
        </thead>
        <tbody>
          {[...markets]
            .sort((a, b) => (a.strikeCents < b.strikeCents ? -1 : 1))
            .map((market) => {
              const asOf = marketAsOf(market, atSecs);
              return (
                <tr key={market.address} className="border-t border-mer-rule align-top">
                  <td className="mer-num py-mer-2 pr-mer-3 font-medium">
                    {formatStrike(market.strikeCents)}
                  </td>
                  <td className="py-mer-2 pr-mer-3">
                    <StateBadge {...badgeProps(asOf, marketStatus(asOf, atSecs), then)} />
                  </td>
                  <td className="py-mer-2 pr-mer-3">
                    <StateBadge {...badgeProps(market, marketStatus(market, nowSecs), today)} />
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </section>
  );
}

/**
 * Markets page in replay: the chosen real session's markets as a frozen, read-only snapshot.
 * No trade links, no live prices, no book; only what the chain can reconstruct.
 */
export function ReplayView({
  tradingDate,
  atSecs,
}: {
  readonly tradingDate: number;
  readonly atSecs: number;
}) {
  const reader = useReader();
  const nowSecs = useNow();
  const markets = useAsync(() => reader.listMarkets(), [reader]);
  const config = useAsync(() => reader.getConfig(), [reader]);
  const overrideDelaySecs = config.status === "ready" ? config.value.overrideDelaySecs : 3_600n;

  let body;
  if (markets.status === "loading" || nowSecs === null) {
    body = <p role="status">Loading the session…</p>;
  } else if (markets.status === "error") {
    body = <p role="alert">Could not load markets: {markets.message}</p>;
  } else {
    const session = markets.value.filter(
      (market) => market.tradingDate === tradingDate && isSessionMarket(market),
    );
    body =
      session.length === 0 ? (
        <p role="status">
          No on-chain markets were found for {formatCalendarDate(tradingDate)}. Pick another day.
        </p>
      ) : (
        groupByTicker(session).map((group) => (
          <ReplayTickerTable
            key={group.ticker}
            ticker={group.ticker}
            markets={group.markets}
            atSecs={atSecs}
            nowSecs={nowSecs}
            overrideDelaySecs={overrideDelaySecs}
          />
        ))
      );
  }
  return (
    <div className="space-y-mer-6" data-testid="replay-view">
      <p className="rounded-mer border border-mer-control-border bg-mer-surface px-mer-3 py-mer-2 text-mer-sm">
        {REPLAY_HONESTY_NOTE}
      </p>
      {body}
    </div>
  );
}
