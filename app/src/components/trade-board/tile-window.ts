/**
 * Pure model for the board's tiles (docs/redesign-spec.md §2.1–2.2): the fixed tile order, the
 * five-strike window around the live price, where the live marker sits, and the words a tile
 * shows when nothing is trading. Prices are integer cents.
 */
import type { BookQuotes } from "@meridian/client";

import { closeSets } from "@/components/markets/ticker-ladder";
import type { FairValue } from "@/lib/fair-values";
import { marketStatus, type MarketRow } from "@/lib/markets";
import type { PythQuote } from "@/lib/pyth-quotes";

// The contract types below mirror docs/redesign-spec.md §4.1 (`trade-board/types.ts`, lead-owned).
// They are structural, so the lead's `TileModel` values fit them; switch these to imports from
// `./types` once that file lands.

export const BOARD_TICKERS = ["AAPL", "AMZN", "GOOGL", "META", "MSFT", "NVDA", "TSLA"] as const;
export type BoardTicker = (typeof BOARD_TICKERS)[number];

/** Everything the board knows about one strike. */
export type StrikeCell = {
  readonly market: MarketRow;
  readonly quotes: BookQuotes | null;
  readonly fair: FairValue | undefined;
};

/** One tile's input. `open`/`closed` ascending by strike. */
export type TileModel = {
  readonly ticker: BoardTicker;
  readonly open: readonly StrikeCell[];
  readonly closed: readonly StrikeCell[];
  readonly pythQuote: PythQuote | undefined;
};

export type FairMeta = {
  readonly status: "loading" | "ready" | "unavailable";
  readonly lastSuccessSecs: number | null;
};

/** At most this many strikes show in a tile; the rest are behind "+N more strikes". */
export const TILE_WINDOW = 5;

/** A tile for every board ticker, in board order; a ticker the caller left out gets an empty one. */
export function orderTiles(tiles: readonly TileModel[]): TileModel[] {
  return BOARD_TICKERS.map(
    (ticker) =>
      tiles.find((tile) => tile.ticker === ticker) ?? {
        ticker,
        open: [],
        closed: [],
        pythQuote: undefined,
      },
  );
}

/** Index of the last strike at or below `live`; -1 when `live` is below every strike or unknown. */
export function belowIndex(strikes: readonly bigint[], live: bigint | null): number {
  if (live === null) return -1;
  return strikes.reduce((found, strike, i) => (strike <= live ? i : found), -1);
}

export type StrikeWindow = {
  /** First shown index into the ascending strikes. */
  readonly start: number;
  /** One past the last shown index. */
  readonly end: number;
  /**
   * The live-price line sits after this shown row (0-based within the window), -1 for above the
   * first shown row, `null` when there is no live price or it falls outside the window.
   */
  readonly markerAfter: number | null;
};

/**
 * The `size` strikes centred on the live price: the strike at or below live is the middle row
 * (two below it, two above for five), clamped to the ends. No live price: the lowest strikes.
 */
export function strikeWindow(
  strikes: readonly bigint[],
  live: bigint | null,
  size: number = TILE_WINDOW,
): StrikeWindow {
  const count = strikes.length;
  const width = Math.max(0, Math.min(size, count));
  const below = belowIndex(strikes, live);
  const wanted = below - Math.floor((width - 1) / 2);
  const start = Math.max(0, Math.min(wanted, count - width));
  const end = start + width;
  let markerAfter: number | null = null;
  if (live !== null && width > 0) {
    if (below === -1) markerAfter = start === 0 ? -1 : null;
    else if (below >= start && below < end) markerAfter = below - start;
  }
  return { start, end, markerAfter };
}

export type TileLadderModel = {
  /** The shown strikes, ascending. */
  readonly rows: readonly StrikeCell[];
  /** The live marker's position within `rows` (see `StrikeWindow.markerAfter`). */
  readonly markerAfter: number | null;
  /** Open strikes not shown in the tile (other strikes of the primary set and later close sets). */
  readonly hidden: number;
  /** The close time of the shown set, `null` when nothing is open. */
  readonly closeTs: bigint | null;
};

/** The tile's ladder: the primary close set (`closeSets`), windowed around the live price. */
export function tileLadder(tile: TileModel): TileLadderModel {
  const live = tile.pythQuote === undefined ? null : BigInt(tile.pythQuote.price_cents);
  const { primary } = closeSets(
    tile.open.map((cell) => cell.market),
    live,
  );
  const byAddress = new Map(tile.open.map((cell) => [cell.market.address, cell]));
  const cells = primary.flatMap((market) => {
    const cell = byAddress.get(market.address);
    return cell === undefined ? [] : [cell];
  });
  const window = strikeWindow(
    cells.map((cell) => cell.market.strikeCents),
    live,
  );
  const rows = cells.slice(window.start, window.end);
  return {
    rows,
    markerAfter: window.markerAfter,
    hidden: tile.open.length - rows.length,
    closeTs: primary[0]?.closeTs ?? null,
  };
}

/**
 * What a tile says when it has no open strike (design.md §3 empty states): nothing listed →
 * "No markets today for {ticker}"; any strike past its settlement window → "Settlement delayed";
 * some unsettled → "Closed · settling"; all settled → "Markets closed". `null` while trading.
 */
export function tileStateText(tile: TileModel, nowSecs: number): string | null {
  if (tile.open.length > 0) return null;
  if (tile.closed.length === 0) return `No markets today for ${tile.ticker}`;
  const statuses = tile.closed.map((cell) => marketStatus(cell.market, nowSecs));
  if (statuses.includes("SettlementDelayed")) return "Settlement delayed";
  if (statuses.some((status) => status !== "Settled")) return "Closed · settling";
  return "Markets closed";
}
