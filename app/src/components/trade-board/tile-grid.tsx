import { StockTile } from "./stock-tile";
import { orderTiles } from "./tile-window";
import type { TileGridProps } from "./types";

/**
 * The board (docs/redesign-spec.md §2.1): the given tiles in board order, one column at 390 px up
 * to four at 1280 px. The session board passes all seven (`buildTiles(…, true)`), so a ticker with
 * no markets still gets its tile; the test-market board passes only tickers that have markets.
 */
export function TileGrid({ tiles, selectedTicker, ...rest }: TileGridProps) {
  return (
    <div
      className="grid grid-cols-1 gap-mer-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      data-testid="tile-grid"
    >
      {orderTiles(tiles).map((tile) => (
        <StockTile
          key={tile.ticker}
          tile={tile}
          selected={tile.ticker === selectedTicker}
          {...rest}
        />
      ))}
    </div>
  );
}
