import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { fair, NOW, quotes } from "@/components/fair-value/test-support";
import { market } from "@/test-utils";
import { NO_QUOTES_TEXT, TileLadder } from "./tile-ladder";
import type { FairMeta, StrikeCell } from "./types";

const FRESH: FairMeta = { status: "ready", lastSuccessSecs: NOW - 1 };

function cell(dollars: number, overrides: Partial<StrikeCell> = {}): StrikeCell {
  return {
    market: market({
      address: `Mkt${dollars}`.padEnd(44, "1"),
      ticker: "NVDA",
      strikeCents: BigInt(dollars * 100),
    }),
    quotes: quotes(57, 59),
    fair: fair({ fair_cents: 54 }),
    ...overrides,
  };
}

function renderLadder(
  rows: readonly StrikeCell[],
  options: { markerAfter?: number | null; hidden?: number; fairMeta?: FairMeta } = {},
) {
  const onSelectMarket = vi.fn();
  const onShowMore = vi.fn();
  render(
    <TileLadder
      ticker="NVDA"
      rows={rows}
      markerAfter={options.markerAfter ?? null}
      hidden={options.hidden ?? 0}
      fairMeta={options.fairMeta ?? FRESH}
      nowSecs={NOW}
      onSelectMarket={onSelectMarket}
      onShowMore={onShowMore}
    />,
  );
  return { onSelectMarket, onShowMore };
}

/** The body row of the strike shown as `$dollars`. */
function row(dollars: number): HTMLElement {
  const strike = screen.getByRole("button", { name: new RegExp(`\\$${dollars}:`) });
  const tr = strike.closest("tr");
  if (tr === null) throw new Error("strike button is not in a row");
  return tr;
}

describe("TileLadder", () => {
  it("is a table with one header row (Strike · YES · Fair · Edge) and one row per strike", () => {
    renderLadder([cell(170), cell(180), cell(190)]);
    const table = screen.getByRole("table", { name: "NVDA strikes" });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((th) => th.textContent);
    expect(headers).toEqual(["Strike", "YES", "Fair", "Edge"]);
    expect(within(table).getAllByRole("row")).toHaveLength(4);
  });

  it("shows YES by the displayed-price rule: mid, wide range, or none", () => {
    renderLadder([
      cell(170, { quotes: quotes(57, 59) }),
      cell(180, { quotes: quotes(55, 70) }),
      cell(190, { quotes: null }),
    ]);
    expect(within(row(170)).getByText("58¢")).toBeInTheDocument();
    expect(row(180)).toHaveTextContent("55–70¢ wide");
    expect(within(row(190)).getByLabelText("price not live yet")).toHaveTextContent("—");
  });

  it("shows fair and the signed edge with its word: rich, cheap, fair", () => {
    renderLadder([
      cell(170, { quotes: quotes(57, 59), fair: fair({ fair_cents: 54 }) }),
      cell(180, { quotes: quotes(40, 42), fair: fair({ fair_cents: 44 }) }),
      cell(190, { quotes: quotes(20, 22), fair: fair({ fair_cents: 21 }) }),
    ]);
    expect(within(row(170)).getByTestId("fair-cell")).toHaveTextContent("54¢");
    const rich = within(row(170)).getByTestId("edge");
    expect(rich).toHaveTextContent("Edge +4¢ (rich)");
    expect(rich).toHaveAttribute("data-tone", "no");
    expect(within(row(180)).getByTestId("edge")).toHaveTextContent("Edge −3¢ (cheap)");
    expect(within(row(190)).getByTestId("edge")).toHaveTextContent("Edge 0¢ (fair)");
  });

  it("shows no edge against a wide or missing price, and says why to screen readers", () => {
    renderLadder([cell(170, { quotes: quotes(40, 70) }), cell(180, { quotes: null })]);
    for (const dollars of [170, 180]) {
      const edge = within(row(dollars)).getByTestId("edge-cell");
      expect(within(edge).queryByTestId("edge")).toBeNull();
      expect(edge).toHaveTextContent("no edge without a tight market price");
    }
    // Fair is still shown: only the edge needs a midpoint.
    expect(within(row(170)).getByTestId("fair-cell")).toHaveTextContent("54¢");
  });

  it("shows — for a strike the service has no value for, and loading while it reads", () => {
    renderLadder([cell(170, { fair: undefined })]);
    expect(within(row(170)).getByTestId("fair-cell")).toHaveTextContent("—no fair value");
    expect(within(row(170)).getByTestId("edge-cell")).toHaveTextContent(
      "no edge without a fair value",
    );
  });

  it("says fair value is loading before the first read", () => {
    renderLadder([cell(170, { fair: undefined })], {
      fairMeta: { status: "loading", lastSuccessSecs: null },
    });
    expect(within(row(170)).getByTestId("fair-cell")).toHaveTextContent("Fair value loading");
  });

  it("mutes a stale fair value and its edge, with a stale tag that says why", () => {
    renderLadder([cell(170, { fair: fair({ fair_cents: 54, stale: true }) })]);
    const fairCell = within(row(170)).getByTestId("fair-cell");
    expect(fairCell).toHaveAttribute("data-stale", "true");
    const tag = within(fairCell).getByTestId("stale-tag");
    expect(tag).toHaveTextContent("the pricing service flagged it stale");
    expect(within(row(170)).getByTestId("edge")).toHaveClass("text-mer-ink-muted");
  });

  it("treats fair values as stale when the app has not read them for over 30 s", () => {
    renderLadder([cell(170)], { fairMeta: { status: "ready", lastSuccessSecs: NOW - 31 } });
    expect(within(row(170)).getByTestId("fair-cell")).toHaveAttribute("data-stale", "true");
    expect(within(row(170)).getByTestId("stale-tag")).toHaveTextContent(
      "no update from the pricing service",
    );
  });

  it("draws the live line as a decorative edge of a row, never as a row", () => {
    renderLadder([cell(170), cell(180), cell(190)], { markerAfter: 1 });
    const markers = screen.getAllByTestId("live-marker");
    expect(markers).toHaveLength(1);
    const marker = markers[0];
    expect(marker).toHaveAttribute("aria-hidden", "true");
    expect(marker?.closest("tr")).toBe(row(180));
    expect(marker).toHaveClass("bottom-0");
    expect(screen.getAllByRole("row")).toHaveLength(4);
  });

  it("draws the live line above the first row when live is below every shown strike", () => {
    renderLadder([cell(170), cell(180)], { markerAfter: -1 });
    const marker = screen.getByTestId("live-marker");
    expect(marker.closest("tr")).toBe(row(170));
    expect(marker).toHaveClass("top-0");
  });

  it("draws no live line without a live price", () => {
    renderLadder([cell(170)], { markerAfter: null });
    expect(screen.queryByTestId("live-marker")).toBeNull();
  });

  it("opens a strike's detail from its row", () => {
    const { onSelectMarket } = renderLadder([cell(170), cell(180)]);
    fireEvent.click(screen.getByRole("button", { name: "NVDA $180: open details" }));
    expect(onSelectMarket).toHaveBeenCalledWith(cell(180).market.address);
  });

  it("offers the hidden strikes as +N more, singular for one, nothing for none", () => {
    const { onShowMore } = renderLadder([cell(170)], { hidden: 4 });
    fireEvent.click(screen.getByRole("button", { name: "+4 more strikes" }));
    expect(onShowMore).toHaveBeenCalledTimes(1);
  });

  it("says +1 more strike in the singular", () => {
    renderLadder([cell(170)], { hidden: 1 });
    expect(screen.getByRole("button", { name: "+1 more strike" })).toBeInTheDocument();
  });

  it("has no more button when every strike is shown", () => {
    renderLadder([cell(170)]);
    expect(screen.queryByRole("button", { name: /more strike/ })).toBeNull();
  });

  it("says no quotes yet when no shown strike has a quote", () => {
    renderLadder([cell(170, { quotes: null }), cell(180, { quotes: null })]);
    expect(screen.getByText(NO_QUOTES_TEXT)).toBeInTheDocument();
  });

  it("says nothing about quotes when one strike is quoted", () => {
    renderLadder([cell(170, { quotes: null }), cell(180)]);
    expect(screen.queryByText(NO_QUOTES_TEXT)).toBeNull();
  });
});
