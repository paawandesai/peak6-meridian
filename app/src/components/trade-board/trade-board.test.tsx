import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TestMarketProvider } from "../test-market-context";
import { buildTiles, TradeBoard, type TileInputs } from "./trade-board";
import { BOARD_TICKERS } from "./types";
import { market, reader, withReader } from "@/test-utils";

const utc = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const NOW = utc("2026-10-08T19:00:00Z"); // Oct 8, 2026 15:00 ET
const TODAY = 20261008;
const SESSION_CLOSE = BigInt(utc("2026-10-08T20:00:00Z")); // 16:00 ET

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/",
}));

const EMPTY: TileInputs = { nowSecs: NOW, books: {}, fairByMarket: {}, pythQuotes: {} };

const board = (markets: ReturnType<typeof market>[] | Promise<never>) =>
  render(
    withReader(
      reader({
        listMarkets: () => (markets instanceof Promise ? markets : Promise.resolve(markets)),
      }),
      <TestMarketProvider>
        <TradeBoard nowSecs={NOW} />
      </TestMarketProvider>,
    ),
  );

describe("buildTiles", () => {
  it("keeps all seven tickers in fixed order when asked, even with no markets", () => {
    const tiles = buildTiles([], EMPTY, true);
    expect(tiles.map((t) => t.ticker)).toEqual([...BOARD_TICKERS]);
    expect(tiles.every((t) => t.open.length === 0 && t.closed.length === 0)).toBe(true);
  });

  it("drops empty tickers and unknown tickers without keepEmpty", () => {
    const tiles = buildTiles(
      [market({ address: "x", ticker: "SPY" }), market({ address: "m", ticker: "META" })],
      EMPTY,
      false,
    );
    expect(tiles.map((t) => t.ticker)).toEqual(["META"]);
  });

  it("splits open from closed, sorts by strike and joins quotes, fair and Pyth", () => {
    const quotes = { yesBid: 40, yesAsk: 44, yesMid: 42, noPrice: 58 };
    const fair = {
      market: "b",
      ticker: "AAPL",
      strike_cents: 23_000,
      fair_cents: 41,
      sigma: 0.3,
      spot: "227.10",
      as_of: "2026-10-08T18:59:50Z",
      stale: false,
    };
    const pyth = {
      ticker: "AAPL" as const,
      price_cents: 22_710,
      conf_cents: 5,
      publish_time: NOW,
      feed_id: "0x",
    };
    const [aapl] = buildTiles(
      [
        market({ address: "b", ticker: "AAPL", strikeCents: 23_000n, closeTs: SESSION_CLOSE }),
        market({ address: "a", ticker: "AAPL", strikeCents: 22_000n, closeTs: SESSION_CLOSE }),
        market({ address: "c", ticker: "AAPL", strikeCents: 21_000n, settled: true }),
      ],
      {
        nowSecs: NOW,
        books: { b: { state: "ready", quotes }, a: { state: "unavailable" } },
        fairByMarket: { b: fair },
        pythQuotes: { AAPL: pyth },
      },
      false,
    );
    expect(aapl?.open.map((c) => c.market.address)).toEqual(["a", "b"]);
    expect(aapl?.closed.map((c) => c.market.address)).toEqual(["c"]);
    expect(aapl?.open[0]?.quotes).toBeNull();
    expect(aapl?.open[1]?.quotes).toEqual(quotes);
    expect(aapl?.open[1]?.fair).toBe(fair);
    expect(aapl?.pythQuote).toBe(pyth);
  });
});

describe("TradeBoard (placeholder)", () => {
  it("shows a loading state while markets are fetched", () => {
    render(
      withReader(
        reader({ listMarkets: () => new Promise(() => {}) }),
        <TestMarketProvider>
          <TradeBoard nowSecs={NOW} />
        </TestMarketProvider>,
      ),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading markets");
  });

  it("shows the error message when the fetch fails", async () => {
    board(Promise.reject(new Error("rpc down")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load markets: rpc down");
  });

  it("shows the empty state with no markets", async () => {
    board([]);
    expect(await screen.findByText(/No markets today/)).toBeInTheDocument();
  });

  it("renders seven tiles and opens and closes the detail placeholder", async () => {
    board([market({ address: "n", ticker: "NVDA", tradingDate: TODAY, closeTs: SESSION_CLOSE })]);
    const nvda = await screen.findByRole("region", { name: "NVDA" });
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      ...BOARD_TICKERS,
    ]);
    expect(within(screen.getByRole("region", { name: "AAPL" })).getByText(/No markets today/));
    fireEvent.click(within(nvda).getByRole("button", { name: "NVDA" }));
    expect(nvda).toHaveAttribute("aria-current", "true");
    const detail = screen.getByRole("region", { name: "NVDA detail" });
    fireEvent.click(within(detail).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("region", { name: "NVDA detail" })).toBeNull();
    expect(nvda).not.toHaveAttribute("aria-current");
  });
});
