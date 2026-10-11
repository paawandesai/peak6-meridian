import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { MarketsPage } from "./markets-page";
import { ReplayGuard, REPLAY_READ_ONLY_NOTE } from "./replay-guard";
import { REPLAY_HONESTY_NOTE, ReplayControl, ReplayView } from "./replay-view";
import { TestMarketProvider } from "./test-market-context";
import { market, reader, withReader } from "@/test-utils";
import type { MarketRow } from "@/lib/markets";

vi.mock("./price-history-chart/price-history-chart", () => ({ PriceHistoryChart: () => null }));
vi.mock("lightweight-charts", () => ({ createChart: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/",
}));

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});
afterEach(() => window.history.pushState({}, "", "/"));

const utc = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const CLOSE = BigInt(utc("2026-10-09T20:00:00Z")); // Fri Oct 9, 16:00 ET
const SETTLED_AT = BigInt(utc("2026-10-09T20:06:00Z"));
const FRIDAY: MarketRow[] = [
  market({
    address: "F1",
    ticker: "AAPL",
    tradingDate: 20261009,
    strikeCents: 22_000n,
    closeTs: CLOSE,
    settled: true,
    outcome: "Yes",
    settledAt: SETTLED_AT,
  }),
  market({
    address: "F2",
    ticker: "AAPL",
    tradingDate: 20261009,
    strikeCents: 23_000n,
    closeTs: CLOSE,
    settled: true,
    outcome: "No",
    settledAt: SETTLED_AT,
  }),
];
const OTHER_DAY = market({ address: "T1", ticker: "AAPL", tradingDate: 20261008 });

function page(markets: readonly MarketRow[]) {
  return render(
    withReader(
      reader({ listMarkets: () => Promise.resolve([...markets]) }),
      <TestMarketProvider>
        <MarketsPage />
      </TestMarketProvider>,
    ),
  );
}

describe("MarketsPage replay", () => {
  it("renders the chosen past session read-only, with no trade links", async () => {
    window.history.pushState({}, "", "/?replay=2026-10-09T10:30");
    page([...FRIDAY, OTHER_DAY]);
    const view = await screen.findByTestId("replay-view");
    expect(view).toHaveTextContent(REPLAY_HONESTY_NOTE);
    const table = await within(view).findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2); // only Fri Oct 9's markets
    // At 10:30 AM ET the market was open; the final column shows the real settlement.
    expect(rows[0]).toHaveTextContent("$220");
    expect(rows[0]).toHaveTextContent("Open · closes 16:00 ET");
    expect(rows[0]).toHaveTextContent("Settled YES");
    expect(rows[1]).toHaveTextContent("Settled NO");
    expect(within(view).queryByRole("link")).toBeNull();
    expect(screen.queryByText(/Trade/)).toBeNull();
  });

  it("says so when the chain has no markets for that day", async () => {
    window.history.pushState({}, "", "/?replay=2026-10-07T10:30");
    page(FRIDAY);
    expect(
      await screen.findByText(/No on-chain markets were found for Wed Oct 7, 2026/),
    ).toBeInTheDocument();
  });

  it("falls back to live markets for an invalid replay link", async () => {
    window.history.pushState({}, "", "/?replay=2026-10-10T10:30"); // a Saturday
    page(FRIDAY);
    expect(await screen.findByRole("form", { name: "Replay a past session" })).toBeInTheDocument();
    expect(screen.queryByTestId("replay-view")).toBeNull();
  });

  it("live: shows the replay control and the Trade board", async () => {
    page(FRIDAY);
    const form = await screen.findByRole("form", { name: "Replay a past session" });
    expect(within(form).getByRole("button", { name: "View replay" })).toBeEnabled();
    expect(screen.queryByTestId("replay-view")).toBeNull();
    expect(await screen.findByTestId("tile-grid")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "AAPL" })).toBeInTheDocument();
    expect(within(form).queryByRole("link", { name: "Back to live" })).toBeNull();
  });
});

describe("ReplayView", () => {
  it("reports a markets read failure", async () => {
    render(
      withReader(
        reader({ listMarkets: () => Promise.reject(new Error("rpc down")) }),
        <ReplayView tradingDate={20261009} atSecs={utc("2026-10-09T14:30:00Z")} />,
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load markets: rpc down");
  });
});

describe("ReplayControl", () => {
  it("submits ?replay= as a plain GET to Markets and offers a way back to live", () => {
    render(<ReplayControl activeAtSecs={utc("2026-10-09T14:30:00Z")} nowSecs={0} />);
    const form = screen.getByRole("form", { name: "Replay a past session" });
    expect(form).toHaveAttribute("method", "get");
    expect(form).toHaveAttribute("action", "/");
    const input = screen.getByLabelText("Replay a past session (read-only)");
    expect(input).toHaveAttribute("name", "replay");
    expect(input).toHaveValue("2026-10-09T10:30");
    expect(screen.getByRole("link", { name: "Back to live" })).toHaveAttribute("href", "/");
  });
});

describe("ReplayGuard (Trade page)", () => {
  const controls = (
    <>
      <button type="button">Buy YES</button>
      <input aria-label="Quantity" />
    </>
  );

  it("disables every trade control in replay and says what the page shows", () => {
    render(<ReplayGuard active>{controls}</ReplayGuard>);
    expect(screen.getByRole("button", { name: "Buy YES" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Quantity" })).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent(REPLAY_READ_ONLY_NOTE);
  });

  it("leaves controls enabled live (real trading unchanged)", () => {
    render(<ReplayGuard active={false}>{controls}</ReplayGuard>);
    expect(screen.getByRole("button", { name: "Buy YES" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Quantity" })).toBeEnabled();
    expect(screen.queryByRole("note")).toBeNull();
  });
});
