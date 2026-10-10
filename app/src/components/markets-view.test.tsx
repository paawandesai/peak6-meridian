import { render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { MarketsView } from "./markets-view";
import { TestMarketProvider } from "./test-market-context";
import { market, reader, withReader } from "@/test-utils";

const utc = (iso: string) => Math.floor(Date.parse(iso) / 1000);
// P0-1: Use a 2026 date (supported year for calendar)
const NOW = utc("2026-10-08T19:00:00Z"); // Oct 8, 2026 15:00 ET
/** The ET trading date of `NOW` (2026-10-08 ET): UI-03 AC1 scopes the page to the active date. */
const TODAY = 20261008;
// Session close for Oct 8, 2026 (16:00 ET = 20:00 UTC in EDT)
const SESSION_CLOSE = BigInt(utc("2026-10-08T20:00:00Z"));

vi.mock("./price-history-chart/price-history-chart", () => ({
  PriceHistoryChart: () => null,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/",
}));

beforeAll(() => {
  // TickerInsight renders DistributionChart (Recharts); jsdom needs ResizeObserver.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

describe("MarketsView", () => {
  it("shows a loading state while markets are fetched", () => {
    render(
      withReader(
        reader({ listMarkets: () => new Promise(() => {}) }),
        <TestMarketProvider>
          <MarketsView />
        </TestMarketProvider>,
      ),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading markets");
  });

  it("shows an empty state", async () => {
    render(
      withReader(
        reader(),
        <TestMarketProvider>
          <MarketsView />
        </TestMarketProvider>,
      ),
    );
    expect(await screen.findByText(/No markets today/)).toBeInTheDocument();
  });

  it("shows the error message when the fetch fails", async () => {
    render(
      withReader(
        reader({ listMarkets: () => Promise.reject(new Error("rpc down")) }),
        <TestMarketProvider>
          <MarketsView />
        </TestMarketProvider>,
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load markets: rpc down");
  });

  it("lists markets grouped by ticker with strike, status and pairs outstanding", async () => {
    const markets = [
      market({
        address: "a",
        ticker: "NVDA",
        tradingDate: TODAY,
        strikeCents: 15_000n,
        pairsOutstanding: 1_200n,
        closeTs: SESSION_CLOSE,
      }),
      market({
        address: "b",
        ticker: "AAPL",
        tradingDate: TODAY,
        strikeCents: 22_000n,
        pairsOutstanding: 3n,
        closeTs: SESSION_CLOSE,
      }),
      market({
        address: "c",
        ticker: "AAPL",
        tradingDate: TODAY,
        strikeCents: 23_000n,
        closeTs: SESSION_CLOSE,
      }),
    ];
    render(
      withReader(
        reader({ listMarkets: () => Promise.resolve(markets) }),
        <TestMarketProvider>
          <MarketsView nowSecs={NOW} />
        </TestMarketProvider>,
      ),
    );

    const aapl = await screen.findByRole("region", { name: "AAPL" });
    // Query the market table specifically (has "Strike" header); TickerInsight adds a distribution table.
    const tables = within(aapl).getAllByRole("table");
    expect(tables.length).toBeGreaterThan(0);
    const marketTable = tables.at(0);
    if (!marketTable) throw new Error("Expected market table");
    // All session markets for same date close together, so all Open at NOW (before session close)
    const rows = within(marketTable).getAllByRole("row").slice(1);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]).toHaveTextContent("$220");
    expect(rows[0]).toHaveTextContent("Open");
    expect(rows[0]).toHaveTextContent("3");

    const nvda = screen.getByRole("region", { name: "NVDA" });
    expect(within(nvda).getByText("1,200")).toBeInTheDocument();
    // Ticker headings (TickerInsight is on Trade page only, not Markets page).
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toContain("AAPL");
    expect(headings).toContain("NVDA");
  });

  it("links each strike to its Trade page (UI-04 AC8)", async () => {
    const markets = [
      market({
        address: "addr1",
        ticker: "NVDA",
        strikeCents: 15_000n,
        tradingDate: TODAY,
        closeTs: SESSION_CLOSE,
      }),
      market({
        address: "addr2",
        ticker: "AAPL",
        strikeCents: 22_000n,
        tradingDate: TODAY,
        closeTs: SESSION_CLOSE,
      }),
      market({
        address: "addr3",
        ticker: "AAPL",
        strikeCents: 23_000n,
        tradingDate: TODAY,
        closeTs: SESSION_CLOSE,
      }),
    ];
    render(
      withReader(
        reader({ listMarkets: () => Promise.resolve(markets) }),
        <TestMarketProvider>
          <MarketsView nowSecs={NOW} />
        </TestMarketProvider>,
      ),
    );

    const strikeLinks = await screen.findAllByRole("link");
    expect(strikeLinks).toHaveLength(3);
    expect(strikeLinks[0]).toHaveAttribute("href", "/trade/addr2");
    expect(strikeLinks[1]).toHaveAttribute("href", "/trade/addr3");
    expect(strikeLinks[2]).toHaveAttribute("href", "/trade/addr1");
  });

  it("filters to session markets by default (P0-1)", async () => {
    // Use Oct 8, 2026 (a regular trading day in the supported year)
    const oct8 = 20261008;
    const sessionClose = BigInt(utc("2026-10-08T20:00:00Z")); // 16:00 ET on 2026-10-08
    // Session market: closeTs matches the session close for its trading date
    const sessionMarket = market({
      address: "session",
      ticker: "NVDA",
      tradingDate: oct8,
      strikeCents: 15_000n,
      closeTs: sessionClose,
    });
    // Test market: closeTs does NOT match the session close (closes 5 min later)
    const testMarket = market({
      address: "test",
      ticker: "NVDA",
      tradingDate: oct8,
      strikeCents: 16_000n,
      closeTs: sessionClose + 300n,
    });
    render(
      withReader(
        reader({ listMarkets: () => Promise.resolve([sessionMarket, testMarket]) }),
        <TestMarketProvider>
          <MarketsView nowSecs={NOW} />
        </TestMarketProvider>,
      ),
    );

    // Only the session market should appear
    await screen.findByRole("region", { name: "NVDA" });
    const strikeLinks = screen.getAllByRole("link");
    expect(strikeLinks).toHaveLength(1);
    expect(strikeLinks[0]).toHaveAttribute("href", "/trade/session");
  });
});
