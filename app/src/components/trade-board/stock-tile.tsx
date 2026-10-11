import { PythPrice, PythPricePlaceholder } from "@/components/pyth-price";
import { formatEtHm } from "@/lib/time";
import { TileLadder } from "./tile-ladder";
import { tileLadder, tileStateText } from "./tile-window";
import type { BoardTicker, StockTileProps } from "./types";

/** `id` of a tile's header button, so the detail view can return focus to it on close. */
export function tileButtonId(ticker: BoardTicker): string {
  return `tile-${ticker}`;
}

/**
 * One stock on the board (docs/redesign-spec.md §2.1): the `h2` holds only the symbol (as a
 * button that opens the detail view); the live price and close time are siblings in the header
 * line. Below, the compact ladder, or the tile's state in words when nothing is trading.
 */
export function StockTile({
  tile,
  fairMeta,
  ctx,
  selected,
  onSelectTicker,
  onSelectMarket,
}: StockTileProps) {
  const ladder = tileLadder(tile);
  const stateText = tileStateText(tile, ctx.nowSecs);
  return (
    <section
      aria-label={tile.ticker}
      data-selected={selected ? "true" : "false"}
      className={`grid min-w-0 content-start gap-mer-2 rounded-mer border p-mer-3 ${selected ? "border-mer-ink ring-1 ring-mer-ink" : "border-mer-rule"}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-mer-3 gap-y-mer-1">
        <h2 className="text-mer-lg font-semibold">
          <button
            type="button"
            id={tileButtonId(tile.ticker)}
            aria-current={selected ? "true" : undefined}
            onClick={() => onSelectTicker(tile.ticker)}
            className="underline-offset-4 hover:underline"
          >
            {tile.ticker}
          </button>
        </h2>
        {tile.pythQuote === undefined ? (
          <PythPricePlaceholder />
        ) : (
          <PythPrice quote={tile.pythQuote} nowMs={ctx.nowSecs * 1000} />
        )}
        {ladder.closeTs === null ? null : (
          <span className="text-mer-xs text-mer-ink-muted">
            closes {formatEtHm(ladder.closeTs)} ET
          </span>
        )}
      </div>
      {stateText === null ? (
        <TileLadder
          ticker={tile.ticker}
          rows={ladder.rows}
          markerAfter={ladder.markerAfter}
          hidden={ladder.hidden}
          fairMeta={fairMeta}
          nowSecs={ctx.nowSecs}
          onSelectMarket={(market) => onSelectMarket(tile.ticker, market)}
          onShowMore={() => onSelectTicker(tile.ticker)}
        />
      ) : (
        <p className="text-mer-sm text-mer-ink-muted" data-testid="tile-state">
          {stateText}
        </p>
      )}
    </section>
  );
}
