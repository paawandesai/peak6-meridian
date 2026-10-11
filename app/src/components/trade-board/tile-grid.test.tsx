import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { fair, NOW, quotes } from "@/components/fair-value/test-support";
import { market } from "@/test-utils";
import { TileGrid } from "./tile-grid";
import { BOARD_TICKERS, type BoardTicker, type TileModel } from "./types";

const CTX = { nowSecs: NOW, paused: false, overrideDelaySecs: 3_600n };

function tile(ticker: BoardTicker): TileModel {
  return {
    ticker,
    open: [
      {
        market: market({
          address: `Mkt${ticker}`.padEnd(44, "1"),
          ticker,
          strikeCents: 20_000n,
          tradingDate: 20261008,
          closeTs: 1_791_489_600n,
        }),
        quotes: quotes(50, 52),
        fair: fair({ ticker, fair_cents: 49 }),
      },
    ],
    closed: [],
    pythQuote: undefined,
  };
}

function empty(ticker: BoardTicker): TileModel {
  return { ticker, open: [], closed: [], pythQuote: undefined };
}

function renderGrid(tiles: readonly TileModel[], selectedTicker: BoardTicker | null = null) {
  const onSelectTicker = vi.fn();
  const onSelectMarket = vi.fn();
  render(
    <TileGrid
      tiles={tiles}
      selectedTicker={selectedTicker}
      fairMeta={{ status: "ready", lastSuccessSecs: NOW - 1 }}
      ctx={CTX}
      onSelectTicker={onSelectTicker}
      onSelectMarket={onSelectMarket}
    />,
  );
  return { onSelectTicker, onSelectMarket };
}

const regionNames = () => screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));

describe("TileGrid", () => {
  it("shows the session board's seven tiles in board order, each saying so when it has no markets", () => {
    renderGrid([...BOARD_TICKERS].reverse().map(empty));
    expect(regionNames()).toEqual([...BOARD_TICKERS]);
    for (const ticker of BOARD_TICKERS) {
      expect(screen.getByRole("region", { name: ticker })).toHaveTextContent(
        `No markets today for ${ticker}`,
      );
    }
  });

  it("orders mixed tiles and keeps each tile's data", () => {
    renderGrid([tile("TSLA"), empty("MSFT"), tile("AAPL")]);
    expect(regionNames()).toEqual(["AAPL", "MSFT", "TSLA"]);
    expect(screen.getByRole("region", { name: "TSLA" })).toHaveTextContent("$200");
    expect(screen.getByRole("region", { name: "MSFT" })).toHaveTextContent(
      "No markets today for MSFT",
    );
  });

  it("adds no tile the caller left out (the test-market board)", () => {
    renderGrid([tile("NVDA")]);
    expect(regionNames()).toEqual(["NVDA"]);
  });

  it("marks only the selected ticker's tile", () => {
    renderGrid(BOARD_TICKERS.map(tile), "META");
    const current = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-current") === "true");
    expect(current.map((b) => b.textContent)).toEqual(["META"]);
  });

  it("passes the tile's ticker with every selection", () => {
    const { onSelectTicker, onSelectMarket } = renderGrid(BOARD_TICKERS.map(tile));
    const amzn = screen.getByRole("region", { name: "AMZN" });
    fireEvent.click(within(amzn).getByRole("button", { name: "AMZN" }));
    fireEvent.click(within(amzn).getByRole("button", { name: "AMZN $200: open details" }));
    expect(onSelectTicker).toHaveBeenCalledWith("AMZN");
    expect(onSelectMarket).toHaveBeenCalledWith("AMZN", tile("AMZN").open[0]?.market.address);
  });

  it("lays out one column at 390 px up to four at 1280 px", () => {
    renderGrid([]);
    expect(screen.getByTestId("tile-grid")).toHaveClass(
      "grid-cols-1",
      "md:grid-cols-2",
      "lg:grid-cols-3",
      "xl:grid-cols-4",
    );
  });
});
