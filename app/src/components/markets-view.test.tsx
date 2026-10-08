import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MarketsView } from "./markets-view";
import { market, reader, withReader } from "@/test-utils";

const NOW = 1_800_000_000;

describe("MarketsView", () => {
  it("shows a loading state while markets are fetched", () => {
    render(withReader(reader({ listMarkets: () => new Promise(() => {}) }), <MarketsView />));
    expect(screen.getByRole("status")).toHaveTextContent("Loading markets");
  });

  it("shows an empty state", async () => {
    render(withReader(reader(), <MarketsView />));
    expect(await screen.findByText(/No markets yet/)).toBeInTheDocument();
  });

  it("shows the error message when the fetch fails", async () => {
    render(
      withReader(
        reader({ listMarkets: () => Promise.reject(new Error("rpc down")) }),
        <MarketsView />,
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load markets: rpc down");
  });

  it("lists markets grouped by ticker with strike, status and pairs outstanding", async () => {
    const markets = [
      market({ address: "a", ticker: "NVDA", strikeCents: 15_000n, pairsOutstanding: 1_200n }),
      market({ address: "b", ticker: "AAPL", strikeCents: 22_000n, pairsOutstanding: 3n }),
      market({ address: "c", ticker: "AAPL", strikeCents: 23_000n, closeTs: BigInt(NOW - 1) }),
      market({ address: "d", ticker: "AAPL", strikeCents: 24_000n, settled: true }),
    ];
    render(
      withReader(
        reader({ listMarkets: () => Promise.resolve(markets) }),
        <MarketsView nowSecs={NOW} />,
      ),
    );

    const aapl = await screen.findByRole("region", { name: "AAPL" });
    const rows = within(aapl).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("$220");
    expect(rows[0]).toHaveTextContent("Open");
    expect(rows[0]).toHaveTextContent("3");
    expect(rows[1]).toHaveTextContent("Closed");
    expect(rows[2]).toHaveTextContent("Settled");

    const nvda = screen.getByRole("region", { name: "NVDA" });
    expect(within(nvda).getByText("1,200")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "AAPL",
      "NVDA",
    ]);
  });
});
