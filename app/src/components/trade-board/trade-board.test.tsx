import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TestMarketProvider } from "../test-market-context";
import { buildTiles, detailTile, TradeBoard, type TileInputs } from "./trade-board";
import { BOARD_TICKERS } from "./types";
import { market, reader, withReader } from "@/test-utils";

const utc = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const NOW = utc("2026-10-08T19:00:00Z"); // Oct 8, 2026 15:00 ET
const TODAY = 20261008;
const SESSION_CLOSE = BigInt(utc("2026-10-08T20:00:00Z")); // 16:00 ET

/** The URL the board reads; `router.replace` writes it, as Next does. */
let search = "";
const replace = vi.fn((url: string) => {
  search = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
});
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({ push: vi.fn(), replace, prefetch: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("lightweight-charts", () => ({
  createChart: () => ({
    addLineSeries: () => ({
      setData: () => undefined,
      createPriceLine: () => ({}),
      removePriceLine: () => undefined,
    }),
    remove: () => undefined,
    timeScale: () => ({ fitContent: () => undefined }),
  }),
}));

/** Base58 market addresses (the board ignores a malformed `?m=`). */
const addr = (tag: string) => tag.padEnd(32, "1");
const N180 = addr("Nvda18");
const N190 = addr("Nvda19");

/** Every network read on `/`, by path: `/api/pyth-history` is the only one the board adds. */
let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
const historyCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/pyth-history")).length;

beforeEach(() => {
  search = "";
  replace.mockClear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  fetchMock = vi.fn((url: string) => {
    if (url.startsWith("/api/pyth-history")) return json({ s: "no_data" });
    if (url.startsWith("/api/pyth-quotes")) {
      return json({
        quotes: [
          {
            ticker: "NVDA",
            price_cents: 18_142,
            conf_cents: 5,
            publish_time: NOW,
            feed_id: "0x",
          },
        ],
        unavailable: [],
        server_time: NOW * 1000,
      });
    }
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const EMPTY: TileInputs = { nowSecs: NOW, books: {}, fairByMarket: {}, pythQuotes: {} };

const listMarkets = vi.fn();
/** Renders the board with one reader for the whole test (the app's reader is stable). */
const board = (markets: ReturnType<typeof market>[] | Promise<never>) => {
  listMarkets.mockReset();
  listMarkets.mockImplementation(() =>
    markets instanceof Promise ? markets : Promise.resolve(markets),
  );
  const value = reader({ listMarkets });
  const ui = () =>
    withReader(
      value,
      <TestMarketProvider>
        <TradeBoard nowSecs={NOW} />
      </TestMarketProvider>,
    );
  const utils = render(ui());
  /** Re-renders after a URL change, as Next does when `useSearchParams` changes. */
  const navigate = () => utils.rerender(ui());
  return { ...utils, navigate };
};

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

const NVDA = [
  market({
    address: N180,
    ticker: "NVDA",
    tradingDate: TODAY,
    strikeCents: 18_000n,
    closeTs: SESSION_CLOSE,
  }),
  market({
    address: N190,
    ticker: "NVDA",
    tradingDate: TODAY,
    strikeCents: 19_000n,
    closeTs: SESSION_CLOSE,
  }),
];

describe("detailTile", () => {
  it("prefers the tile whose open strikes hold the market, else the first tile for the ticker", () => {
    const session = buildTiles([], EMPTY, true).filter((t) => t.ticker === "NVDA");
    const test = buildTiles(NVDA, EMPTY, false);
    expect(detailTile(null, null, [session, test])).toBeUndefined();
    expect(detailTile("NVDA", N190, [session, test])).toBe(test[0]);
    expect(detailTile("NVDA", null, [session, test])).toBe(session[0]);
    expect(detailTile("AAPL", null, [session])).toBeUndefined();
  });
});

describe("TradeBoard", () => {
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

  it("renders the seven tiles in order with the symbol-only h2 (AC1, AC5)", async () => {
    board(NVDA);
    await screen.findByRole("region", { name: "NVDA" });
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      ...BOARD_TICKERS,
    ]);
    expect(
      within(screen.getByRole("region", { name: "AAPL" })).getByText(/No markets today for AAPL/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("detail-view")).toBeNull();
  });

  it("opens the detail from the tile, moves focus to it, and returns focus on Close (AC9)", async () => {
    const { navigate } = board(NVDA);
    const tile = await screen.findByRole("button", { name: "NVDA" });
    fireEvent.click(tile);
    expect(replace).toHaveBeenLastCalledWith("/?t=NVDA", { scroll: false });
    navigate();
    const detail = await screen.findByTestId("detail-view");
    expect(within(detail).getByRole("heading", { level: 2, name: "NVDA" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "NVDA" })).toHaveAttribute("aria-current", "true");
    fireEvent.click(within(detail).getByRole("button", { name: "Close" }));
    expect(replace).toHaveBeenLastCalledWith("/", { scroll: false });
  });

  it("lands on ?t=&m= with that strike, and Esc closes and focuses the tile button (AC9, AC10)", async () => {
    search = `t=NVDA&m=${N190}`;
    const { navigate } = board(NVDA);
    const detail = await screen.findByTestId("detail-view");
    expect(within(detail).getByRole("radio", { name: /\$190/ })).toBeChecked();
    expect(within(detail).getByRole("link", { name: /Trade this strike/ })).toHaveAttribute(
      "href",
      `/trade/${N190}`,
    );
    fireEvent.click(within(detail).getByRole("radio", { name: /\$180/ }));
    expect(replace).toHaveBeenLastCalledWith(`/?t=NVDA&m=${N180}`, { scroll: false });
    fireEvent.keyDown(within(detail).getByRole("heading", { level: 2 }), { key: "Escape" });
    expect(search).toBe("");
    navigate();
    await waitFor(() => expect(screen.queryByTestId("detail-view")).toBeNull());
    expect(screen.getByRole("button", { name: "NVDA" })).toHaveFocus();
  });

  it("ignores an unknown ?t= (AC10)", async () => {
    search = "t=SPY";
    board(NVDA);
    await screen.findByRole("region", { name: "NVDA" });
    expect(screen.queryByTestId("detail-view")).toBeNull();
  });

  it("reads markets once and fetches price history only while the detail is open (AC11)", async () => {
    const { navigate, unmount } = board(NVDA);
    await screen.findByRole("region", { name: "NVDA" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(historyCalls()).toBe(0);
    search = "t=NVDA";
    navigate();
    await screen.findByTestId("detail-view");
    await waitFor(() => expect(historyCalls()).toBe(1));
    expect(listMarkets).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("shows test markets in their own board only when the toggle is on", async () => {
    const testMarket = market({
      address: addr("Test1"),
      ticker: "TSLA",
      tradingDate: TODAY,
      strikeCents: 25_000n,
      closeTs: SESSION_CLOSE - 600n,
    });
    board([...NVDA, testMarket]);
    const toggle = await screen.findByRole("button", { name: /test market/i });
    expect(screen.queryByRole("heading", { name: "Test Markets" })).toBeNull();
    fireEvent.click(toggle);
    const section = screen.getByRole("region", { name: "Test Markets" });
    expect(
      within(section)
        .getAllByRole("heading", { level: 2 })
        .map((h) => h.textContent),
    ).toEqual(["TSLA"]);
    fireEvent.click(within(section).getByRole("button", { name: "TSLA" }));
    expect(replace).toHaveBeenLastCalledWith(`/?t=TSLA&m=${addr("Test1")}`, { scroll: false });
  });
});
