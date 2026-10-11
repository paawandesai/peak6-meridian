/**
 * Pure model for the board's tiles (docs/redesign-spec.md §2.1–2.2): the fixed tile order, the
 * five-strike window around the live price, where the live marker sits, and the words a tile
 * shows when nothing is trading. Prices are integer cents.
 */
import { closeSets } from "@/components/markets/ticker-ladder";
import { marketStatus } from "@/lib/markets";
import { BOARD_TICKERS, type StrikeCell, type TileModel } from "./types";

/** At most this many strikes show in a tile; the rest are behind "+N more strikes". */
export const TILE_WINDOW = 5;

/**
 * The given tiles in board order (spec §2.1). Which tiles exist is the caller's choice: the
 * session board passes all seven, the test-market board only tickers that have markets.
 */
export function orderTiles(tiles: readonly TileModel[]): TileModel[] {
  const rank = (tile: TileModel) => BOARD_TICKERS.indexOf(tile.ticker);
  return [...tiles].sort((a, b) => rank(a) - rank(b));
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
