import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const clock = vi.hoisted(() => ({ now: null as number | null }));
vi.mock("./use-now", () => ({ useNow: () => clock.now }));
vi.mock("@solana/wallet-adapter-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana/wallet-adapter-react")>()),
  useWallet: () => ({ publicKey: null }),
}));

import { MarketsView } from "./markets-view";
import { TestMarketProvider } from "./test-market-context";
import { market, reader, withReader } from "@/test-utils";

const utc = (iso: string) => Math.floor(Date.parse(iso) / 1000);
// Oct 8, 2026 is a trading day, session close at 16:00 ET = 20:00 UTC (EDT)
const SESSION_CLOSE = BigInt(utc("2026-10-08T20:00:00Z"));

const markets = [
  market({
    address: "1111111111111111111111111111111A",
    tradingDate: 20261008,
    ticker: "NVDA",
    closeTs: SESSION_CLOSE,
  }),
];
const view = () =>
  withReader(
    reader({ listMarkets: () => Promise.resolve(markets) }),
    <TestMarketProvider>
      <MarketsView />
    </TestMarketProvider>,
  );

describe("MarketsView before the clock has mounted", () => {
  it("shows loading, never a 'Showing markets from … (closed)' line from a 1970 clock", async () => {
    clock.now = null;
    const { rerender } = render(view());
    // Give the reader time to resolve: the page must still be waiting for the clock.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole("status")).toHaveTextContent("Loading markets");
    expect(screen.queryByText(/Showing markets from/)).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();

    // Once the clock is set (today is Oct 8 ET), today's markets are shown with no closed line.
    clock.now = Math.floor(Date.parse("2026-10-08T15:00:00Z") / 1000);
    rerender(view());
    await waitFor(() => expect(screen.getByRole("region", { name: "NVDA" })).toBeInTheDocument());
    expect(screen.queryByText(/Showing markets from/)).toBeNull();
  });
});
