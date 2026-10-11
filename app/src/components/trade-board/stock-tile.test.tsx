import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { fair, NOW, quotes } from "@/components/fair-value/test-support";
import { market } from "@/test-utils";
import type { PythQuote } from "@/lib/pyth-quotes";
import { StockTile, tileButtonId } from "./stock-tile";
import type { StrikeCell, TileModel } from "./types";

const CLOSE = 1_791_489_600n; // 2026-10-08 16:00 ET
const CTX = { nowSecs: NOW, paused: false, overrideDelaySecs: 3_600n };

function cell(dollars: number, overrides: Partial<Parameters<typeof market>[0]> = {}): StrikeCell {
  return {
    market: market({
      address: `Mkt${dollars}`.padEnd(44, "1"),
      ticker: "NVDA",
      strikeCents: BigInt(dollars * 100),
      tradingDate: 20261008,
      closeTs: CLOSE,
      ...overrides,
    }),
    quotes: quotes(57, 59),
    fair: fair({ fair_cents: 54 }),
  };
}

const PYTH: PythQuote = {
  ticker: "NVDA",
  price_cents: 18_142,
  conf_cents: 0,
  publish_time: NOW - 2,
  feed_id: "feed",
};

function tile(overrides: Partial<TileModel> = {}): TileModel {
  return {
    ticker: "NVDA",
    open: [150, 160, 170, 180, 190, 200, 210, 220].map((d) => cell(d)),
    closed: [],
    pythQuote: PYTH,
    ...overrides,
  };
}

function renderTile(model: TileModel, selected = false) {
  const onSelectTicker = vi.fn();
  const onSelectMarket = vi.fn();
  render(
    <StockTile
      tile={model}
      fairMeta={{ status: "ready", lastSuccessSecs: NOW - 1 }}
      ctx={CTX}
      selected={selected}
      onSelectTicker={onSelectTicker}
      onSelectMarket={onSelectMarket}
    />,
  );
  return { onSelectTicker, onSelectMarket, region: screen.getByRole("region", { name: "NVDA" }) };
}

describe("StockTile", () => {
  it("is a region named by its ticker whose h2 holds only the symbol", () => {
    const { region } = renderTile(tile());
    const heading = within(region).getByRole("heading", { level: 2 });
    expect(heading.textContent).toBe("NVDA");
  });

  it("shows the live Pyth price and the close time in ET in the header line", () => {
    const { region } = renderTile(tile());
    expect(region).toHaveTextContent("$181.42");
    expect(region).toHaveTextContent("closes 16:00 ET");
  });

  it("says the price is loading before the first Pyth quote", () => {
    const { region } = renderTile(tile({ pythQuote: undefined }));
    expect(region).toHaveTextContent("Pyth price loading");
  });

  it("shows five strikes centred on live and the rest behind +N more", () => {
    const { region } = renderTile(tile());
    const strikes = within(region)
      .getAllByRole("button", { name: /open details/ })
      .map((b) => b.textContent);
    expect(strikes).toEqual(["$160", "$170", "$180", "$190", "$200"]);
    expect(within(region).getByRole("button", { name: "+3 more strikes" })).toBeInTheDocument();
  });

  it("opens the detail view from the header, a strike row, or +N more", () => {
    const { onSelectTicker, onSelectMarket, region } = renderTile(tile());
    fireEvent.click(within(region).getByRole("button", { name: "NVDA" }));
    fireEvent.click(within(region).getByRole("button", { name: "+3 more strikes" }));
    expect(onSelectTicker).toHaveBeenNthCalledWith(1, "NVDA");
    expect(onSelectTicker).toHaveBeenNthCalledWith(2, "NVDA");
    fireEvent.click(within(region).getByRole("button", { name: "NVDA $180: open details" }));
    expect(onSelectMarket).toHaveBeenCalledWith("NVDA", cell(180).market.address);
  });

  it("marks the selected tile on its header button, which carries a stable id", () => {
    const { region } = renderTile(tile(), true);
    const button = within(region).getByRole("button", { name: "NVDA" });
    expect(button).toHaveAttribute("aria-current", "true");
    expect(button).toHaveAttribute("id", tileButtonId("NVDA"));
    expect(region).toHaveAttribute("data-selected", "true");
  });

  it("does not mark an unselected tile", () => {
    const { region } = renderTile(tile());
    expect(within(region).getByRole("button", { name: "NVDA" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("shows the state in words and no table when nothing is trading", () => {
    const { region } = renderTile(
      tile({ open: [], closed: [cell(180, { closeTs: BigInt(NOW - 60) })] }),
    );
    expect(within(region).getByTestId("tile-state")).toHaveTextContent("Closed · settling");
    expect(within(region).queryByRole("table")).toBeNull();
    expect(region).not.toHaveTextContent("closes");
  });

  it("says a ticker has no markets today", () => {
    const { region } = renderTile(tile({ open: [], closed: [] }));
    expect(region).toHaveTextContent("No markets today for NVDA");
  });
});
