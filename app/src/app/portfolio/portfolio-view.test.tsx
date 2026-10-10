import { PublicKey } from "@solana/web3.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const wallet = vi.hoisted(() => ({
  publicKey: null as PublicKey | null,
  signAllTransactions: undefined as undefined | (() => Promise<never>),
}));
const modal = vi.hoisted(() => ({ setVisible: vi.fn() }));
vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => wallet,
  useConnection: () => ({ connection: {} }),
}));
vi.mock("@solana/wallet-adapter-react-ui", () => ({ useWalletModal: () => modal }));

import type { PortfolioActions } from "./actions";
import type { PortfolioSource } from "./data";
import { AAPL, fill, held, MSFT, NVDA, OTHER, snapshot, WALLET } from "./fixtures";
import { CONNECT_COPY, MARK_FOOTNOTE, PortfolioView } from "./portfolio-view";
import { TestMarketProvider } from "@/components/test-market-context";
import type { MarketDataSources } from "@/lib/market-data";
import { reader, withReader } from "@/test-utils";

const KEY = new PublicKey("11111111111111111111111111111112");
/** Unix seconds for a UTC ISO string. */
const utc = (iso: string) => Math.floor(Date.parse(iso) / 1000);
// Oct 8, 2026 15:00 ET - before the 16:00 ET session close
const NOW = utc("2026-10-08T19:00:00Z");

function setup(
  options: {
    snap?: ReturnType<typeof snapshot>;
    bid?: number | null;
    ask?: number | null;
    actions?: PortfolioActions;
    markets?: (typeof NVDA)[];
  } = {},
) {
  wallet.publicKey = KEY;
  const events = options.snap ?? snapshot();
  const source: PortfolioSource = { load: vi.fn().mockResolvedValue(events) };
  const marketSources: MarketDataSources = {
    fetchPrices: () => Promise.resolve({ prices: [], unavailable: [] }),
    fetchBooks: (markets) =>
      Promise.resolve(
        Object.fromEntries(
          markets.map((m) => [
            m.toBase58(),
            {
              yesBid: options.bid === undefined ? 58 : options.bid,
              yesAsk: options.ask === undefined ? 61 : options.ask,
              yesMid: 59,
              noPrice: 41,
            },
          ]),
        ),
      ),
  };
  const actions =
    options.actions ??
    ({
      redeem: vi.fn().mockResolvedValue({ signature: "sig", slot: 42 }),
      withdraw: vi.fn().mockResolvedValue({ signature: "sig", slot: 43 }),
    } satisfies PortfolioActions);
  render(
    withReader(
      reader({
        listMarkets: () => Promise.resolve(options.markets ?? [NVDA, AAPL, MSFT]),
        usdcBalance: () => Promise.resolve(1_250_000_000n),
      }),
      <TestMarketProvider>
        <PortfolioView
          source={source}
          actions={actions}
          marketSources={marketSources}
          nowSecs={NOW}
        />
      </TestMarketProvider>,
    ),
  );
  return { source, actions };
}

beforeEach(() => {
  wallet.publicKey = null;
  wallet.signAllTransactions = undefined;
  modal.setVisible.mockReset();
});

const buyNvda = (price: number, qty: bigint) =>
  fill(`buy${price}`, NVDA.address, { taker: WALLET, maker: OTHER, takerSide: "Bid", price, qty });

// The fake wallet key is not WALLET, so events are addressed to the connected key.
const as = (events: ReturnType<typeof buyNvda>[]) =>
  events.map((e) => (e.kind === "Fill" ? { ...e, taker: KEY.toBase58() } : e));

describe("Portfolio page", () => {
  it("asks for a wallet first and opens the connect dialog", () => {
    render(
      withReader(
        reader(),
        <TestMarketProvider>
          <PortfolioView />
        </TestMarketProvider>,
      ),
    );
    expect(screen.getByText(CONNECT_COPY)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(modal.setVisible).toHaveBeenCalledWith(true);
  });

  it("shows loading, then an error when the snapshot cannot be read", async () => {
    wallet.publicKey = KEY;
    const source: PortfolioSource = { load: () => Promise.reject(new Error("rpc down")) };
    render(
      withReader(
        reader({ listMarkets: () => Promise.resolve([NVDA]) }),
        <TestMarketProvider>
          <PortfolioView source={source} />
        </TestMarketProvider>,
      ),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading portfolio");
    expect(await screen.findByRole("alert")).toHaveTextContent("rpc down");
  });

  it("AC1/AC1b: every column is present and the half-cent mid and non-whole average print exactly", async () => {
    setup({
      snap: snapshot({
        holdings: { [NVDA.address]: held(7n, 0n) },
        events: as([buyNvda(41, 3n), buyNvda(42, 4n)]),
      }),
    });
    const table = await screen.findByRole("table", { name: "Positions" });
    for (const name of [
      "Market",
      "Side",
      "Qty",
      "Avg entry",
      "Mark",
      "If right pays",
      "Unrealized",
      "Realized",
      "State",
    ]) {
      expect(within(table).getByRole("columnheader", { name })).toBeInTheDocument();
    }
    const row = within(table).getByRole("row", { name: /NVDA/ });
    const cells = within(row)
      .getAllByRole("cell")
      .map((cell) => cell.textContent);
    expect(within(row).getByRole("rowheader")).toHaveTextContent("NVDA ≥ $180 10/08");
    expect(cells).toContain("7"); // qty
    expect(cells).toContain("41.5¢"); // 291¢ / 7 = 41.57¢ floored to a tenth
    await waitFor(() => expect(row).toHaveTextContent("59.5¢"), { timeout: 3000 }); // (58 + 61) × 5 tenths
    // 59.5¢ × 7 − 291¢ = $1.255 → floors to +$1.25, printed with its sign character.
    expect(row).toHaveTextContent("+$1.25");
    expect(row).toHaveTextContent("$7.00"); // if right pays
    expect(row).toHaveTextContent("YES");
  });

  it("a fractional-cent loss is printed with a minus sign and in the loss colour", async () => {
    setup({
      snap: snapshot({
        holdings: { [NVDA.address]: held(1n, 0n) },
        events: as([buyNvda(60, 1n)]),
      }),
    });
    const losses = await screen.findAllByText("−$0.01", undefined, { timeout: 3000 });
    // The row and the totals line both print it, each with the sign and the loss colour.
    expect(losses).toHaveLength(2);
    for (const loss of losses) expect(loss).toHaveClass("text-mer-loss");
    expect(screen.getByText(MARK_FOOTNOTE)).toBeInTheDocument();
  });

  it("AC2: a settled winner shows its payout and Redeem; a loser shows $0.00 and no Redeem", async () => {
    const { actions } = setup({
      snap: snapshot({
        holdings: {
          [AAPL.address]: held(40n, 0n),
          [MSFT.address]: held(5n, 0n),
        },
        events: as([
          fill("a", AAPL.address, {
            taker: KEY.toBase58(),
            maker: OTHER,
            takerSide: "Bid",
            price: 55,
            qty: 40n,
          }),
          fill("b", MSFT.address, {
            taker: KEY.toBase58(),
            maker: OTHER,
            takerSide: "Bid",
            price: 30,
            qty: 5n,
          }),
        ]),
      }),
    });
    fireEvent.click(await screen.findByRole("tab", { name: "Closed" }));
    const won = (await screen.findByRole("rowheader", { name: /AAPL/ })).closest("tr");
    const lost = screen.getByRole("rowheader", { name: /MSFT/ }).closest("tr");
    expect(won).not.toBeNull();
    expect(lost).not.toBeNull();
    if (won === null || lost === null) return;
    expect(won).toHaveTextContent("Settled YES at $231.02");
    expect(won).toHaveTextContent("$40.00");
    expect(within(won).getByRole("button", { name: "Redeem $40.00" })).toBeEnabled();
    expect(lost).toHaveTextContent("Lost: pays $0.00");
    expect(lost).toHaveTextContent("$0.00");
    expect(within(lost).queryByRole("button")).toBeNull();

    // One click, one call, one confirmation line with an explorer link.
    fireEvent.click(within(won).getByRole("button", { name: "Redeem $40.00" }));
    expect(await screen.findByText(/Confirmed in slot 42/)).toBeInTheDocument();
    expect(actions.redeem).toHaveBeenCalledTimes(1);
    expect(actions.redeem).toHaveBeenCalledWith([
      expect.objectContaining({
        market: AAPL,
        yesAccounts: [expect.objectContaining({ amount: 40n })],
        noAccounts: [],
      }),
    ]);
    expect(screen.getByRole("link", { name: /view on explorer/ })).toHaveAttribute(
      "href",
      expect.stringContaining("explorer.solana.com/tx/sig"),
    );
  });

  it("Redeem all redeems every winning market in one call", async () => {
    const { actions } = setup({
      snap: snapshot({
        holdings: { [AAPL.address]: held(40n, 2n) },
        events: as([
          fill("a", AAPL.address, {
            taker: KEY.toBase58(),
            maker: OTHER,
            takerSide: "Bid",
            price: 55,
            qty: 40n,
          }),
        ]),
      }),
    });
    expect(await screen.findByText("Redeemable now")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Redeem all" }));
    await screen.findByText(/Confirmed in slot 42/);
    expect(actions.redeem).toHaveBeenCalledTimes(1);
    expect(actions.redeem).toHaveBeenCalledWith([
      expect.objectContaining({
        market: AAPL,
        yesAccounts: [expect.objectContaining({ amount: 40n })],
        noAccounts: [expect.objectContaining({ amount: 2n })],
      }),
    ]);
  });

  it("a failed transaction says so in words and nothing was charged", async () => {
    const actions: PortfolioActions = {
      redeem: vi.fn().mockRejectedValue(new Error("user rejected the request")),
      withdraw: vi.fn(),
    };
    setup({
      actions,
      snap: snapshot({
        holdings: { [AAPL.address]: held(1n, 0n) },
        events: as([
          fill("a", AAPL.address, {
            taker: KEY.toBase58(),
            maker: OTHER,
            takerSide: "Bid",
            price: 55,
            qty: 1n,
          }),
        ]),
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Redeem all" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed: user rejected the request. Nothing was charged.",
    );
  });

  it("AC3: the MM block lists strikes and Withdraw calls settle_funds; it collapses with no open orders", async () => {
    const { actions } = setup({
      snap: snapshot({
        holdings: { [NVDA.address]: held(25n, 0n) },
        openOrders: [{ market: NVDA.address, freeUsdc: 12_400_000n, freeYes: 0n, restingCount: 3 }],
        resting: [{ market: NVDA.address, orderId: 1n, side: "Bid", price: 40, qty: 5n }],
        events: as([buyNvda(40, 25n)]),
      }),
    });
    const block = await screen.findByRole("region", { name: "MM exposure" });
    expect(within(block).getByRole("rowheader")).toHaveTextContent("NVDA ≥ $180 10/08");
    expect(block).toHaveTextContent("+25");
    expect(block).toHaveTextContent("Open orders 3");
    expect(block).toHaveTextContent("Unsettled $12.40");
    fireEvent.click(within(block).getByRole("button", { name: "Withdraw" }));
    await screen.findByText(/Confirmed in slot 43/);
    expect(actions.withdraw).toHaveBeenCalledWith([NVDA]);
  });

  it("AC3: the MM block collapses to one line for a wallet with no open orders", async () => {
    setup({ snap: snapshot() });
    const block = await screen.findByRole("region", { name: /MM exposure/ });
    expect(block).toHaveTextContent("no open orders");
    expect(within(block).queryByRole("table")).toBeNull();
  });

  it("AC5: three filters each show their own rows; resting orders list the book orders", async () => {
    setup({
      snap: snapshot({
        holdings: {
          [NVDA.address]: held(10n, 0n),
          [AAPL.address]: held(4n, 0n),
        },
        openOrders: [{ market: NVDA.address, freeUsdc: 0n, freeYes: 0n, restingCount: 1 }],
        resting: [{ market: NVDA.address, orderId: 9n, side: "Bid", price: 44, qty: 6n }],
        events: as([
          buyNvda(40, 10n),
          fill("c", AAPL.address, {
            taker: KEY.toBase58(),
            maker: OTHER,
            takerSide: "Bid",
            price: 50,
            qty: 4n,
          }),
        ]),
      }),
    });
    // Open (default): the unsettled NVDA position only.
    const positions = await screen.findByRole("table", { name: "Positions" });
    expect(within(positions).getByRole("rowheader", { name: /NVDA/ })).toBeInTheDocument();
    expect(within(positions).queryByRole("rowheader", { name: /AAPL/ })).toBeNull();
    expect(screen.getByRole("tab", { name: "Open" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("tab", { name: "Resting orders" }));
    const resting = screen.getByRole("table", { name: "Resting orders" });
    expect(resting).toHaveTextContent("Buy YES (bid)");
    expect(resting).toHaveTextContent("44¢");
    expect(screen.queryByRole("table", { name: "Positions" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Closed" }));
    const closed = screen.getByRole("table", { name: "Positions" });
    expect(within(closed).getByRole("rowheader", { name: /AAPL/ })).toBeInTheDocument();
    expect(within(closed).queryByRole("rowheader", { name: /NVDA/ })).toBeNull();
  });

  it("empty filters say so in words", async () => {
    setup({ snap: snapshot() });
    expect(await screen.findByText("No open positions.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Resting orders" }));
    expect(screen.getByText("No resting orders.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Closed" }));
    expect(screen.getByText("No closed positions.")).toBeInTheDocument();
  });

  it("states: an open market carries a badge and a countdown; history gaps are announced", async () => {
    setup({
      snap: snapshot({
        holdings: { [NVDA.address]: held(7n, 0n) },
        eventsPartial: true,
      }),
    });
    const row = (await screen.findByRole("rowheader", { name: /NVDA/ })).closest("tr");
    if (row === null) throw new Error("no row");
    expect(row).toHaveTextContent("Closes in");
    expect(screen.getByRole("note")).toHaveTextContent("History incomplete");
    // P&L cells are dashes with a text alternative, never an invented number.
    expect(within(row).getAllByLabelText("not available").length).toBeGreaterThan(0);
  });

  it("the total line carries the balance, redeemable, unrealized and realized figures", async () => {
    setup({
      snap: snapshot({
        holdings: { [NVDA.address]: held(10n, 0n) },
        events: as([buyNvda(40, 10n)]),
      }),
    });
    const totals = await screen.findByLabelText("Totals");
    expect(totals).toHaveTextContent("1,250.00 test-USDC");
    expect(totals).toHaveTextContent("Redeemable now $0.00");
    expect(totals).toHaveTextContent("Realized $0.00");
  });

  it("shows non-zero redeemable amount correctly formatted", async () => {
    setup({
      snap: snapshot({
        holdings: { [AAPL.address]: held(40n, 0n) },
        events: as([
          fill("a", AAPL.address, {
            taker: KEY.toBase58(),
            maker: OTHER,
            takerSide: "Bid",
            price: 55,
            qty: 40n,
          }),
        ]),
      }),
    });
    const totals = await screen.findByLabelText("Totals");
    expect(totals).toHaveTextContent("Redeemable now $40.00");
  });
});
