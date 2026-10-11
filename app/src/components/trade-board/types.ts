/**
 * Shared contracts for the one-page Trade board (docs/redesign-spec.md §4.1). Lead-owned: a
 * worker that needs a change asks the lead; nobody else edits this file.
 */
import type { BookQuotes } from "@meridian/client";
import type { FairValue, FairValues } from "@/lib/fair-values";
import type { BadgeContext } from "@/lib/market-view";
import type { MarketRow } from "@/lib/markets";
import type { PythQuote } from "@/lib/pyth-quotes";

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

export type FairMeta = Pick<FairValues, "status" | "lastSuccessSecs">;

export type StockTileProps = {
  readonly tile: TileModel;
  readonly fairMeta: FairMeta;
  readonly ctx: BadgeContext;
  readonly selected: boolean;
  readonly onSelectTicker: (ticker: BoardTicker) => void;
  readonly onSelectMarket: (ticker: BoardTicker, market: string) => void;
};

export type TileGridProps = Omit<StockTileProps, "tile" | "selected"> & {
  readonly tiles: readonly TileModel[];
  readonly selectedTicker: BoardTicker | null;
};

export type DetailViewProps = {
  readonly tile: TileModel;
  /** Address of the selected strike, or `null` for the default (§2.3). */
  readonly selectedMarket: string | null;
  readonly fair: FairValues;
  readonly ctx: BadgeContext;
  readonly onSelectMarket: (market: string) => void;
  readonly onClose: () => void;
  readonly tradeHref: (market: Pick<MarketRow, "address">) => string;
};
