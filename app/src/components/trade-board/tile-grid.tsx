import { StockTile, type StockTileProps } from "./stock-tile";
import { type BoardTicker, type TileModel, orderTiles } from "./tile-window";

export type TileGridProps = Omit<StockTileProps, "tile" | "selected"> & {
  readonly tiles: readonly TileModel[];
  readonly selectedTicker: BoardTicker | null;
};

/**
 * The board (docs/redesign-spec.md §2.1): always seven tiles in board order, one column at 390 px
 * up to four at 1280 px. A ticker with no markets still gets its tile.
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
