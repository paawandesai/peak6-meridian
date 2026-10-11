import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DetailView } from "./detail-view";
import type { DetailViewProps, StrikeCell, TileModel } from "./types";
import { tradeHref } from "@/app/trade/_lib/href";
import { fair, ladder, NOW, quotes } from "@/components/fair-value/test-support";
import type { PriceLineChartProps } from "@/components/price-line-chart/price-line-chart";
import type { FairValues } from "@/lib/fair-values";
import type { PythQuote } from "@/lib/pyth-quotes";
import { market } from "@/test-utils";

const chartProps = vi.fn();
vi.mock("@/components/price-line-chart/price-line-chart", () => ({
  PriceLineChart: (props: PriceLineChartProps) => {
    chartProps(props);
    return <p data-testid="price-line-stub">{props.ticker} price chart</p>;
  },
}));

beforeAll(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

beforeEach(() => {
  chartProps.mockClear();
});

const [m170, m180, m190] = [...ladder()].sort((a, b) => (a.strikeCents < b.strikeCents ? -1 : 1));
const A170 = m170?.address ?? "";
const A180 = m180?.address ?? "";
const A190 = m190?.address ?? "";

const pyth = (priceCents: number): PythQuote => ({
  ticker: "NVDA",
  price_cents: priceCents,
  conf_cents: 0,
  publish_time: NOW - 1,
  feed_id: "0xfeed",
});

const cell = (row: typeof m170, bid: number | null, ask: number | null): StrikeCell => ({
  market: row ?? market(),
  quotes: bid === null && ask === null ? null : quotes(bid, ask),
  fair: undefined,
});

const TILE: TileModel = {
  ticker: "NVDA",
  open: [cell(m170, 70, 72), cell(m180, 55, 57), cell(m190, 30, 33)],
  closed: [],
  pythQuote: pyth(18_142),
};

const FAIR: FairValues = {
  status: "ready",
  lastSuccessSecs: NOW - 1,
  byMarket: {
    [A170]: fair({ market: A170, strike_cents: 17_000, fair_cents: 69 }),
    [A180]: fair({ market: A180, strike_cents: 18_000, fair_cents: 52 }),
    [A190]: fair({ market: A190, strike_cents: 19_000, fair_cents: 35 }),
  },
};

const CTX = { nowSecs: NOW, paused: false, overrideDelaySecs: 3600n };

function view(overrides: Partial<DetailViewProps> = {}) {
  const props: DetailViewProps = {
    tile: TILE,
    selectedMarket: null,
    fair: FAIR,
    ctx: CTX,
    onSelectMarket: vi.fn(),
    onClose: vi.fn(),
    tradeHref,
    ...overrides,
  };
  return { props, ...render(<DetailView {...props} />) };
}

describe("DetailView: header and focus (AC9)", () => {
  it("shows the symbol as the heading, the Pyth price and the close time", () => {
    view();
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading).toHaveTextContent(/^NVDA$/);
    expect(screen.getByRole("region", { name: "NVDA" })).toBeInTheDocument();
    expect(screen.getByText("$181.42")).toBeInTheDocument();
    expect(screen.getByText("closes 16:00 ET")).toBeInTheDocument();
  });

  it("shows the Pyth placeholder without a quote", () => {
    view({ tile: { ...TILE, pythQuote: undefined } });
    expect(screen.getByText("Pyth price loading")).toBeInTheDocument();
  });

  it("moves focus to its heading when it opens and when the ticker changes", () => {
    const { rerender, props } = view();
    expect(screen.getByRole("heading", { level: 2 })).toHaveFocus();
    (document.activeElement as HTMLElement).blur();
    rerender(<DetailView {...props} tile={{ ...TILE, ticker: "TSLA" }} />);
    expect(screen.getByRole("heading", { level: 2, name: "TSLA" })).toHaveFocus();
  });

  it("closes with the Close button and with Esc", () => {
    const { props } = view();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("heading", { level: 2 }), { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByRole("heading", { level: 2 }), { key: "Enter" });
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });
});

describe("DetailView: strike, fair value and trade link (AC6)", () => {
  it("defaults to the strike at or just above the live price", () => {
    view(); // live $181.42 → $190
    expect(screen.getByRole("radio", { name: "$190" })).toBeChecked();
    // mid of 30/33 = 31 against fair 35 → cheap.
    expect(screen.getByTestId("fair-edge")).toHaveTextContent("Fair 35¢ · Edge −4¢ (cheap)");
    const link = screen.getByRole("link", { name: /Trade this strike/ });
    expect(link).toHaveAttribute("href", `/trade/${A190}`);
    expect(link).toHaveAccessibleName("Trade this strike: NVDA $190");
  });

  it("selects the strike given by its address", () => {
    view({ selectedMarket: A180 });
    expect(screen.getByRole("radio", { name: "$180" })).toBeChecked();
    expect(screen.getByTestId("fair-edge")).toHaveTextContent("Fair 52¢ · Edge +4¢ (rich)");
    expect(screen.getByRole("link", { name: /Trade this strike/ })).toHaveAttribute(
      "href",
      `/trade/${A180}`,
    );
  });

  it("ignores an address that is not on the ladder", () => {
    view({ selectedMarket: "Unknown1111" });
    expect(screen.getByRole("radio", { name: "$190" })).toBeChecked();
  });

  it("uses the middle strike when there is no live price", () => {
    view({ tile: { ...TILE, pythQuote: undefined } });
    expect(screen.getByRole("radio", { name: "$180" })).toBeChecked();
  });

  it("reports a strike chosen in the selector", () => {
    const { props } = view();
    fireEvent.click(screen.getByRole("radio", { name: "$170" }));
    expect(props.onSelectMarket).toHaveBeenCalledWith(A170);
  });

  it("says when the strike has no fair value, and that fair value is loading", () => {
    const { rerender, props } = view({ fair: { ...FAIR, byMarket: {} } });
    expect(screen.queryByTestId("fair-edge")).not.toBeInTheDocument();
    expect(screen.getByText("No fair value for this strike.")).toBeInTheDocument();
    rerender(
      <DetailView {...props} fair={{ status: "loading", lastSuccessSecs: null, byMarket: {} }} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Fair value loading…");
    expect(screen.queryByText("No fair value for this strike.")).not.toBeInTheDocument();
  });

  it("shows a stale fair value muted with its tag", () => {
    view({
      fair: {
        ...FAIR,
        byMarket: { [A190]: fair({ market: A190, fair_cents: 35, stale: true }) },
      },
    });
    expect(screen.getByTestId("fair-edge")).toHaveAttribute("data-stale", "true");
    expect(within(screen.getByTestId("fair-edge")).getByTestId("stale-tag")).toBeInTheDocument();
  });

  it("only offers the primary close set's strikes", () => {
    const later = market({
      address: "Later11111111111111111111111111111111111111",
      ticker: "NVDA",
      strikeCents: 25_000n,
      tradingDate: 20261009,
      closeTs: 1_791_576_000n,
    });
    view({ tile: { ...TILE, open: [...TILE.open, cell(later, 5, 7)] } });
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.queryByRole("radio", { name: "$250" })).not.toBeInTheDocument();
  });

  it("says there is nothing to trade when no market is open", () => {
    view({ tile: { ...TILE, open: [], closed: TILE.open } });
    expect(screen.getByText("No open markets for NVDA right now.")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Trade this strike/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/^closes/)).not.toBeInTheDocument();
  });
});

describe("DetailView: charts (AC7, AC8)", () => {
  it("draws the implied distribution from the ladder", () => {
    view();
    expect(screen.getByText("Implied distribution: NVDA")).toBeInTheDocument();
    expect(screen.getByTestId("distribution-table")).toBeInTheDocument();
    expect(screen.queryByTestId("distribution-empty")).not.toBeInTheDocument();
  });

  it("says so in words when no strike is priced", () => {
    view({
      tile: { ...TILE, open: [cell(m170, 10, 60), cell(m180, null, null), cell(m190, 30, null)] },
    });
    expect(screen.getByTestId("distribution-empty")).toHaveTextContent(
      "No market-implied distribution yet: no NVDA strike has a two-sided book within 10¢.",
    );
    expect(screen.queryByText("Implied distribution: NVDA")).not.toBeInTheDocument();
  });

  it("gives the price chart the ladder's strikes and the selected one, never fair value", () => {
    view({ selectedMarket: A180 });
    expect(screen.getByTestId("price-line-stub")).toBeInTheDocument();
    const props = chartProps.mock.lastCall?.[0] as PriceLineChartProps;
    expect(props).toEqual({
      ticker: "NVDA",
      nowSecs: NOW,
      strikes: [17_000n, 18_000n, 19_000n],
      selectedStrikeCents: 18_000n,
    });
  });

  it("gives the price chart no strikes when nothing is open", () => {
    view({ tile: { ...TILE, open: [] } });
    const props = chartProps.mock.lastCall?.[0] as PriceLineChartProps;
    expect(props.strikes).toEqual([]);
    expect(props.selectedStrikeCents).toBeNull();
  });
});
