import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MarketsView } from "../markets-view";
import { MarketSourcesProvider, type MarketSources } from "./data-context";
import { MIDPOINT_NOTE, SETTLE_NOTE, CONNECT_COPY } from "./notes";
import { market, reader, withReader } from "@/test-utils";
import { PYTH_FEED_IDS } from "@/lib/pyth-quotes";

const wallet = vi.hoisted(() => ({ publicKey: null as unknown }));
vi.mock("@solana/wallet-adapter-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana/wallet-adapter-react")>()),
  useWallet: () => wallet,
}));

const mockFairValues = vi.hoisted(() => ({
  status: "ready" as const,
  byMarket: {} as Record<string, unknown>,
  refreshFailed: false,
}));
vi.mock("@/lib/fair-values", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fair-values")>()),
  useFairValues: () => mockFairValues,
}));

vi.mock("../price-history-chart/price-history-chart", () => ({
  PriceHistoryChart: () => null,
}));

const utc = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const NOW = utc("2026-10-08T19:00:00Z"); // 15:00 ET
const TODAY = 20261008;
const CLOSE = BigInt(utc("2026-10-08T20:00:00Z")); // 16:00 ET
const OPEN = utc("2026-10-08T13:00:00Z"); // 09:00 ET

type Q = {
  yesBid: number | null;
  yesAsk: number | null;
  yesMid: number | null;
  noPrice: number | null;
};
const q = (bid: number | null, ask: number | null): Q => ({
  yesBid: bid,
  yesAsk: ask,
  yesMid: bid !== null && ask !== null ? Math.floor((bid + ask) / 2) : null,
  noPrice: null,
});

function sources(options: {
  books?: Record<string, Q | null>;
  prices?: { ticker: string; price_cents: number }[];
  open?: Record<string, number | null>;
}): MarketSources {
  return {
    data: {
      fetchPrices: () =>
        Promise.resolve({
          prices: (options.prices ?? []).map((p) => ({
            ...p,
            ticker: p.ticker as never,
            as_of: new Date((NOW - 3) * 1000).toISOString(),
            stale: false,
          })),
          unavailable: [],
        }),
      fetchBooks: () => Promise.resolve(options.books ?? ({} as never)),
    },
    openTimes: () => Promise.resolve(options.open ?? {}),
  };
}

const addr = (n: number) => `1111111111111111111111111111111${n}`;
const m = (n: number, over: Parameters<typeof market>[0] = {}) =>
  market({
    address: addr(n),
    ticker: "NVDA",
    tradingDate: TODAY,
    closeTs: CLOSE,
    strikeCents: BigInt(17_000 + n * 1_000),
    ...over,
  });

/**
 * Mock Pyth quotes API for tests (M3-10).
 * Call this before rendering to provide Pyth price data.
 */
function mockPythQuotes(prices: { ticker: string; price_cents: number }[]) {
  const publishTime = NOW - 2; // 2 seconds ago
  const mockResponse = {
    quotes: prices.map((p) => ({
      ticker: p.ticker,
      price_cents: p.price_cents,
      conf_cents: Math.floor(p.price_cents * 0.001), // ~0.1% confidence
      publish_time: publishTime,
      feed_id: PYTH_FEED_IDS[p.ticker as keyof typeof PYTH_FEED_IDS] ?? "0x0",
    })),
    unavailable: [],
    server_time: Date.now(),
  };

  global.fetch = vi.fn((url) => {
    if (typeof url === "string" && url.includes("/api/pyth-quotes")) {
      return Promise.resolve({
        ok: true,
        json: async () => mockResponse,
      } as Response);
    }
    return Promise.reject(new Error(`Unmocked fetch: ${url}`));
  });
}

function renderView(
  markets: ReturnType<typeof market>[],
  opts: {
    sources?: MarketSources;
    now?: number;
    paused?: boolean;
    tradeHref?: ((x: ReturnType<typeof market>) => string) | null;
  } = {},
) {
  const view = (
    <MarketSourcesProvider sources={opts.sources ?? sources({})}>
      <MarketsView
        {...(opts.now === undefined ? { nowSecs: NOW } : { nowSecs: opts.now })}
        {...(opts.tradeHref === undefined ? {} : { tradeHref: opts.tradeHref })}
      />
    </MarketSourcesProvider>
  );
  return render(
    withReader(
      reader({
        listMarkets: () => Promise.resolve(markets),
        getConfig: () =>
          Promise.resolve({
            admin: "11111111111111111111111111111111",
            paused: opts.paused ?? false,
            overrideDelaySecs: 3_600n,
          }),
      }),
      view,
    ),
  );
}

const rowFor = async (strikeText: string) =>
  (await screen.findAllByRole("row")).find((row) =>
    row.textContent?.includes(strikeText),
  ) as HTMLElement;

describe("all open markets shown (updated behavior)", () => {
  const earlier = (n: number) => m(n, { address: addr(n + 5), tradingDate: 20261007 });

  it("shows all open markets across all dates, no 'Showing markets from' line", async () => {
    renderView([m(1), earlier(2)]);
    expect(await screen.findAllByRole("row")).toHaveLength(3); // header + two strikes (both dates)
    expect(screen.queryByText(/Showing markets from/)).toBeNull();
  });

  it("with the clock on the earlier date, shows all open markets from both dates", async () => {
    // Two NVDA dates: Oct 7 (3 strikes) and Oct 8 (1 strike); the clock is on Oct 7 (15:00 ET).
    renderView([earlier(1), earlier(2), earlier(3), m(4)], { now: utc("2026-10-07T19:00:00Z") });
    const section = await screen.findByRole("region", { name: "NVDA" });
    expect(within(section).getAllByRole("row")).toHaveLength(5); // header + all 4 strikes
    expect(within(section).getByText(/^4 strikes/)).toBeInTheDocument();
    expect(screen.queryByText(/Showing markets from/)).toBeNull();
  });

  it("with the clock on the later date, shows all open markets from both dates", async () => {
    mockPythQuotes([{ ticker: "NVDA", price_cents: 21_142 }]);
    renderView([earlier(1), earlier(2), m(3), m(4), m(5)]);
    const section = await screen.findByRole("region", { name: "NVDA" });
    await vi.waitFor(() => expect(section).toHaveTextContent("$211.42"));
    expect(within(section).getByText(/^5 strikes/)).toBeInTheDocument(); // all 5 strikes shown
    expect(within(section).getAllByRole("row")).toHaveLength(7); // header + 5 strikes + 1 price marker row
  });

  it("shows open markets from any date, even when it's not today", async () => {
    // Saturday (Oct 10) but markets from Oct 7 are still open (not settled)
    renderView([earlier(1), earlier(2)], { now: utc("2026-10-10T15:00:00Z") });
    const section = await screen.findByRole("region", { name: "NVDA" });
    expect(screen.queryByText(/Showing markets from/)).toBeNull();
    expect(within(section).getAllByRole("row")).toHaveLength(3); // header + 2 strikes
  });

  it("an empty reader result is the only 'No markets today'", async () => {
    renderView([]);
    expect(await screen.findByText(/No markets today/)).toBeInTheDocument();
  });
});

describe("row link (AC2)", () => {
  it("renders an anchor in the strike cell (never on the row) when tradeHref is given", async () => {
    renderView([m(1)], { tradeHref: (x) => `/trade/${x.address}` });
    const row = await rowFor("$180");
    const link = within(row).getByRole("link");
    expect(link).toHaveAttribute("href", `/trade/${addr(1)}`);
    expect(row.tagName).toBe("TR");
    expect(row.closest("a")).toBeNull();
    expect(link).toHaveClass("after:absolute", "after:inset-0");
  });

  it("renders no link and no Trade text when tradeHref is null", async () => {
    renderView([m(1)], { tradeHref: null });
    await screen.findAllByRole("row");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("Trade")).toBeNull();
  });
});

describe("states (AC3): every state shows its words", () => {
  const at = async (over: Parameters<typeof market>[0], now: number, paused = false) => {
    renderView([m(1, over)], { now, paused });
    return rowFor("$180");
  };
  const C = Number(CLOSE);

  it("Open", async () => expect(await at({}, NOW)).toHaveTextContent("Open"));
  it("Closing soon counts down to the close", async () =>
    expect(await at({}, C - 724)).toHaveTextContent("Closes in 12:04"));
  it("Closed names the settling time in ET", async () =>
    expect(await at({}, C + 10)).toHaveTextContent("Closed, settling at 16:05 ET"));
  it("Settling has no attempt number", async () => {
    const row = await at({}, C + 400);
    expect(row).toHaveTextContent("Settling…");
    expect(row.textContent).not.toMatch(/attempt/);
  });
  it("Settlement delayed names the override time, then 'available now'", async () => {
    const before = await at({}, C + 1_300);
    expect(before).toHaveTextContent("an admin override opens at 17:00 ET");
    expect(before.querySelector(".mer-spin")).toBeNull();
  });
  it("Settlement delayed at and after close + override delay says available now", async () => {
    expect(await at({}, C + 3_600)).toHaveTextContent("an admin override is available now");
  });
  it("Settled YES and NO show the outcome and the floored settle price", async () => {
    const yes = await at(
      { settled: true, outcome: "Yes", settlePriceScaled: 181_426_000_000_000_000_000n },
      C + 10,
    );
    expect(yes).toHaveTextContent("Settled YES at $181.42");
  });
  it("Settled NO", async () => {
    const no = await at(
      { settled: true, outcome: "No", settlePriceScaled: 178_100_000_000_000_000_000n },
      C + 10,
    );
    expect(no).toHaveTextContent("Settled NO at $178.10");
  });
  it("Paused shows only on an otherwise Open market; Settled and Closed keep their own badge", async () => {
    expect(await at({}, NOW, true)).toHaveTextContent("Paused: trading and minting stopped");
  });
  it("paused + settled shows Settled", async () => {
    expect(await at({ settled: true }, C + 10, true)).toHaveTextContent("Settled YES at $181.00");
  });
  it("paused + closed shows Closed", async () => {
    const row = await at({}, C + 10, true);
    expect(row).toHaveTextContent("Closed, settling at 16:05 ET");
    expect(row.textContent).not.toMatch(/Paused/);
  });
});

describe("open time, close time and countdown to the next transition (D-050)", () => {
  it("shows the creation time and the close time in ET (no countdown for Open status)", async () => {
    renderView([m(1)], { sources: sources({ open: { [addr(1)]: OPEN } }) });
    const row = await rowFor("$180");
    await vi.waitFor(() => expect(row).toHaveTextContent("Opened 09:00 ET · closes 16:00 ET"));
    // Open status shows no countdown (only badge shows "closes HH:MM ET")
    expect(row.textContent).not.toMatch(/Closing soon in/);
  });

  it("an unreadable creation time shows a dash, not a made-up time", async () => {
    renderView([m(1)]);
    expect(await rowFor("$180")).toHaveTextContent("Opened — · closes 16:00 ET");
  });

  it("the ticker header says how many strikes and when they close", async () => {
    renderView([m(1), m(2)]);
    const section = await screen.findByRole("region", { name: "NVDA" });
    expect(within(section).getByText("2 strikes · closes 16:00 ET")).toBeInTheDocument();
  });
});

describe("displayed price (AC7, AC4)", () => {
  const withBook = async (bid: number | null, ask: number | null) => {
    renderView([m(1)], { sources: sources({ books: { [addr(1)]: q(bid, ask) } }) });
    await vi.waitFor(async () => expect((await rowFor("$180")).textContent).toMatch(/\d+¢/));
    return rowFor("$180");
  };

  it("midpoint with a derived NO and a probability when the spread is 10c or less", async () => {
    const row = await withBook(50, 60);
    expect(row).toHaveTextContent("55¢");
    expect(row).toHaveTextContent("45¢");
    expect(row).toHaveTextContent("55%");
    expect(within(row).getByTestId("bar-fill")).toHaveStyle({ width: "55%" });
    expect(row).not.toHaveTextContent("wide");
  });

  it("a bid and ask range, 'wide spread', the NO range, no probability and an outlined bar at 11c", async () => {
    const row = await withBook(50, 61);
    expect(row).toHaveTextContent("50–61¢");
    expect(row).toHaveTextContent("wide");
    expect(row).toHaveTextContent("39–50¢");
    expect(row.textContent).not.toMatch(/\d+%/);
    expect(within(row).queryByTestId("bar-fill")).toBeNull();
    expect(within(row).getByTestId("bar-range")).toBeInTheDocument();
  });

  it("a one-sided book is a range with only the derived side", async () => {
    const row = await withBook(40, null);
    expect(row).toHaveTextContent("40¢");
    expect(row).toHaveTextContent("60¢");
    expect(row.textContent).not.toMatch(/\d+%/);
  });

  it("no live book shows a dash, never a number", async () => {
    renderView([m(1)]);
    const row = await rowFor("$180");
    expect(row.textContent).not.toMatch(/\d+¢/);
    expect(within(row).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("YES and NO labels are in column headers, not individual cells", async () => {
    renderView([m(1)]);
    const section = await screen.findByRole("region", { name: "NVDA" });
    const headers = within(section).getAllByRole("columnheader");
    expect(headers.some((h) => h.textContent === "YES")).toBe(true);
    expect(headers.some((h) => h.textContent === "NO")).toBe(true);
  });
});

describe("page notes and landing (AC7)", () => {
  it("hides the 'trading has stopped' help while any market is still open", async () => {
    renderView([m(1, { closeTs: BigInt(NOW - 60) }), m(2, { closeTs: CLOSE + 7_200n })]);
    await screen.findAllByRole("row");
    expect(screen.queryByText(SETTLE_NOTE)).toBeNull();
  });

  it("the midpoint warning is always-visible text in the document, with no hover or focus", async () => {
    renderView([m(1)]);
    expect(await screen.findByText(MIDPOINT_NOTE)).toBeVisible();
    expect(screen.getAllByText(MIDPOINT_NOTE)).toHaveLength(1);
  });

  it("the 'closed does not mean settled' help appears once, only while a Closed, Settling or delayed market exists", async () => {
    const closed = renderView([m(1), m(2)], { now: Number(CLOSE) + 10 });
    expect(await screen.findAllByText(SETTLE_NOTE)).toHaveLength(1);
    closed.unmount();
    renderView([m(1)]);
    await screen.findAllByRole("row");
    expect(screen.queryByText(SETTLE_NOTE)).toBeNull();
  });

  it("never puts the help text inside a badge or a row", async () => {
    renderView([m(1)], { now: Number(CLOSE) + 10 });
    const row = await rowFor("$180");
    expect(row.textContent).not.toContain("closed does not mean settled");
  });

  it("the landing says what connecting does and hides once a wallet is connected", async () => {
    wallet.publicKey = null;
    const first = renderView([m(1)]);
    expect(await screen.findByText(CONNECT_COPY)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeInTheDocument();
    first.unmount();
    wallet.publicKey = { toBase58: () => "x" };
    renderView([m(1)]);
    await screen.findAllByRole("row");
    expect(screen.queryByText(CONNECT_COPY)).toBeNull();
    wallet.publicKey = null;
  });
});

describe("live price (header line)", () => {
  it("shows the live Pyth price with freshness indicator and a price marker row between strikes", async () => {
    mockPythQuotes([{ ticker: "NVDA", price_cents: 18_142 }]);
    renderView([m(1), m(2), m(3)]);
    const section = await screen.findByRole("region", { name: "NVDA" });
    await vi.waitFor(() => expect(section).toHaveTextContent("$181.42"));
    // Check for Pyth badge and freshness (M3-10)
    expect(section).toHaveTextContent(/\ds ago/); // e.g., "2s ago"
    expect(section).toHaveTextContent("Pyth");
    // Price marker is now a row, not an inline marker element
    const rows = within(section).getAllByRole("row");
    expect(rows).toHaveLength(5); // header + 3 strikes + 1 price marker row
    // Check for price marker row with Pyth label
    expect(section.textContent).toMatch(/Pyth.*\$181\.42/);
  });

  it("shows loading placeholder when Pyth price is not yet available", async () => {
    mockPythQuotes([]); // No quotes returned
    renderView([m(1)]);
    const section = await screen.findByRole("region", { name: "NVDA" });
    await vi.waitFor(() => expect(section).toHaveTextContent("Pyth price loading"));
    expect(within(section).getByRole("heading", { level: 2 })).toHaveTextContent(/^NVDA$/);
  });
});

describe("fair value and edge (M3-03: AC per-strike)", () => {
  it("mounts FairEdge on each strike row with that market's fair value", async () => {
    // Three strikes with distinct fair values
    const markets = [m(1), m(2), m(3)];
    mockFairValues.byMarket = {
      [addr(1)]: {
        market: addr(1),
        fair_cents: 50,
        ticker: "NVDA",
        strike_cents: 18000,
        sigma: 0.3,
        spot: 18142,
        as_of: new Date(NOW * 1000).toISOString(),
        stale: false,
      },
      [addr(2)]: {
        market: addr(2),
        fair_cents: 45,
        ticker: "NVDA",
        strike_cents: 19000,
        sigma: 0.3,
        spot: 18142,
        as_of: new Date(NOW * 1000).toISOString(),
        stale: false,
      },
      [addr(3)]: {
        market: addr(3),
        fair_cents: 40,
        ticker: "NVDA",
        strike_cents: 20000,
        sigma: 0.3,
        spot: 18142,
        as_of: new Date(NOW * 1000).toISOString(),
        stale: false,
      },
    };
    renderView(markets, {
      sources: sources({
        books: {
          [addr(1)]: q(50, 52), // $180 strike: 51¢ mid
          [addr(2)]: q(45, 47), // $190 strike: 46¢ mid
          [addr(3)]: q(40, 42), // $200 strike: 41¢ mid
        },
      }),
    });

    const section = await screen.findByRole("region", { name: "NVDA" });
    // Header + 3 strikes = 4 rows
    expect(within(section).getAllByRole("row")).toHaveLength(4);

    // Each strike row should have a FairEdge (data-testid="fair-edge")
    const fairEdges = within(section).getAllByTestId("fair-edge");
    expect(fairEdges).toHaveLength(3);
  });
});
