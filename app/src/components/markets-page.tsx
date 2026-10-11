"use client";

import { ReplayControl, ReplayView } from "./replay-view";
import { TradeBoard } from "./trade-board/trade-board";
import { useReplay } from "./use-replay";

/**
 * The Markets page body: the live Trade board (docs/redesign-spec.md), or (with a valid `?replay=`) the read-only replay of a
 * past session. An invalid replay link falls back to live; the header shows why.
 */
export function MarketsPage() {
  const replay = useReplay();
  const control =
    replay === null ? null : (
      <ReplayControl
        activeAtSecs={replay.kind === "replay" ? replay.atSecs : null}
        nowSecs={Math.floor(Date.now() / 1000)}
      />
    );
  if (replay?.kind === "replay") {
    return (
      <div className="space-y-mer-6">
        {control}
        <ReplayView tradingDate={replay.tradingDate} atSecs={replay.atSecs} />
      </div>
    );
  }
  return (
    <div className="space-y-mer-6">
      <TradeBoard />
      {control}
    </div>
  );
}
