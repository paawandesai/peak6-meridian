import { fireEvent, render, screen, waitFor, within, configure } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TradeView } from "./trade-view";
import { CLOSED_HELP } from "../_lib/state";
import { BOOK, EMPTY_WALLET, fakeActions, fakeReader, order, USER } from "../_lib/test-support";
import type { WalletView } from "../_lib/reader";
import type { AppConfig } from "@/lib/chain";
import { market } from "@/test-utils";

// The shared dev box can be heavily loaded; generous waits keep these from flaking.
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 60_000 });

// 2026-10-08 16:00 ET close = 20:00Z.
const CLOSE = 1_791_489_600;
const open = market({
  ticker: "NVDA",
  strikeCents: 18_000n,
  tradingDate: 20261008,
  closeTs: BigInt(CLOSE),
});
const settledYes = market({
  ticker: "NVDA",
  strikeCents: 18_000n,
  tradingDate: 20261008,
  closeTs: BigInt(CLOSE),
  settled: true,
  outcome: "Yes",
  settlePriceScaled: 181_420_000_000_000_000_000n,
});
const config: AppConfig = { paused: false, overrideDelaySecs: 3600n, admin: "A" };
const paused: AppConfig = { ...config, paused: true };

/** A wallet that could use every recovery action: a resting bid, a free balance, YES and NO. */
const BUSY_WALLET: WalletView = {
  yes: 40n,
  no: 8n,
  usdc: 5_000_000n,
  freeUsdc: 1_500_000n,
  freeYes: 2n,
};
const BOOK_WITH_MINE = { bids: [...BOOK.bids, order("bid", 50, 4, USER, 9)], asks: BOOK.asks };

function renderState(m: typeof open, cfg: AppConfig, nowSecs: number) {
  const fake = fakeActions();
  render(
    <TradeView
      market={m}
      config={cfg}
      nowSecs={nowSecs}
      reader={fakeReader({
        getWallet: () => Promise.resolve(BUSY_WALLET),
        getBook: () => Promise.resolve(BOOK_WITH_MINE),
      })}
      actions={fake.actions}
      wallet={USER}
      marketData={{ prices: {}, pricesUnavailable: [], books: {} }}
      fairValues={{ status: "loading", byMarket: {}, refreshFailed: false }}
      ladder={[]}
      explorerUrl={(s) => s}
      debounceMs={0}
    />,
  );
  return fake;
}

async function settle() {
  // The wallet actions load asynchronously; wait for the cancel row, which every state shows.
  await screen.findByText("Resting YES bid: 4 at 50¢");
}

function expectNoTrading(fake: ReturnType<typeof fakeActions>) {
  const group = screen.getByRole("radiogroup", { name: "What do you want to do?" });
  for (const radio of within(group).getAllByRole("radio")) expect(radio).toBeDisabled();
  expect(screen.getByRole("button", { name: /^Sign and/ })).toBeDisabled();
  // No order form, no payoff sentence, no simulation line, no Mint control.
  expect(screen.queryByLabelText(/Quantity/)).toBeNull();
  expect(screen.queryByText(/^You pay /)).toBeNull();
  expect(screen.queryByText(/^You receive /)).toBeNull();
  expect(screen.queryByTestId("simulation-line")).toBeNull();
  expect(screen.queryByTestId("cost-strip")).toBeNull();
  expect(screen.queryByRole("button", { name: /mint/i })).toBeNull();
  expect(fake.calls.filter((c) => c.name === "simulate")).toHaveLength(0);
}

const reason = () => screen.getByTestId("panel-reason");

describe.each([
  [
    "Paused (an otherwise open market)",
    open,
    paused,
    CLOSE - 3600,
    "Paused: trading and minting stopped; cancel, withdraw and redeem still work",
    false,
  ],
  [
    "Paused, in the closing-soon window",
    open,
    paused,
    CLOSE - 60,
    "Paused: trading and minting stopped; cancel, withdraw and redeem still work",
    false,
  ],
  ["Closed", open, config, CLOSE + 1, "Closed: no new orders; settling at 16:05 ET", true],
  ["Settling", open, config, CLOSE + 5 * 60, "Settling…", true],
  [
    "Paused and closed follows the Closed row",
    open,
    paused,
    CLOSE + 1,
    "Closed: no new orders; settling at 16:05 ET",
    true,
  ],
] as const)("%s (UI-04 AC7)", (_name, m, cfg, now, text, hasHelp) => {
  it("disables all four intents with the reason, and keeps Cancel, Withdraw and pair Redeem", async () => {
    const fake = renderState(m, cfg, now);
    await settle();
    expect(reason()).toHaveTextContent(
      new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    );
    expectNoTrading(fake);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Redeem 8 pairs for $8.00" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /^Redeem \$/ })).toBeNull(); // no winner Redeem
    if (hasHelp) {
      // The help is its own element, directly under the reason, and the reason is unchanged.
      const help = screen.getByTestId("panel-help");
      expect(help).toHaveTextContent(CLOSED_HELP);
      expect(help).not.toBe(reason());
      expect(reason().textContent).not.toContain(CLOSED_HELP);
      expect(reason().nextElementSibling).toBe(help);
    } else {
      expect(screen.queryByTestId("panel-help")).toBeNull();
    }
  });
});

describe("Settlement delayed (UI-04 AC7)", () => {
  const prefix = "Settlement delayed: automatic settlement has stopped; ";

  it.each([
    [CLOSE + 20 * 60, `${prefix}an admin override opens at 17:00 ET`],
    [CLOSE + 3599, `${prefix}an admin override opens at 17:00 ET`],
    [CLOSE + 3600, `${prefix}an admin override is available now`],
    [CLOSE + 3601, `${prefix}an admin override is available now`],
  ])("at %i the reason reads %j", async (now, text) => {
    const fake = renderState(open, config, now);
    await settle();
    expect(reason()).toHaveTextContent(text);
    expect(screen.getByTestId("panel-help")).toHaveTextContent(CLOSED_HELP);
    expectNoTrading(fake);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Redeem 8 pairs for $8.00" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /^Redeem \$/ })).toBeNull();
  });

  it("uses overrideDelaySecs from the config", async () => {
    renderState(open, { ...config, overrideDelaySecs: 1800n }, CLOSE + 25 * 60);
    await settle();
    expect(reason()).toHaveTextContent(`${prefix}an admin override opens at 16:30 ET`);
  });
});

describe("Settled (UI-04 AC7)", () => {
  it("shows the outcome, offers Cancel, Withdraw and winner Redeem with its payout, and no pair Redeem", async () => {
    const fake = renderState(settledYes, config, CLOSE + 10 * 60);
    await settle();
    expect(reason()).toHaveTextContent(/^Settled YES at \$181\.42$/);
    expect(screen.queryByTestId("panel-help")).toBeNull();
    expectNoTrading(fake);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Redeem $40.00" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /pairs? for/ })).toBeNull();
    // Losing tokens pay nothing.
    expect(screen.getByText("Your 8 NO pay $0.00.")).toBeInTheDocument();
  });

  it("winner Redeem is one transaction burning the whole balances", async () => {
    const fake = renderState(settledYes, config, CLOSE + 10 * 60);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Redeem $40.00" }));
    await waitFor(() => expect(fake.calls.some((c) => c.name === "redeemWinner")).toBe(true));
    expect(fake.calls.filter((c) => c.name === "redeemWinner").map((c) => c.args)).toEqual([
      [40n, 8n],
    ]);
  });

  it("paused and settled follows the Settled row, with the Settled reason", async () => {
    const fake = renderState(settledYes, paused, CLOSE + 10 * 60);
    await settle();
    expect(reason()).toHaveTextContent(/^Settled YES at \$181\.42$/);
    expectNoTrading(fake);
    expect(screen.getByRole("button", { name: "Redeem $40.00" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /pairs? for/ })).toBeNull();
  });

  it("a NO outcome pays the NO tokens and names the YES tokens as losing", async () => {
    const settledNo = {
      ...settledYes,
      outcome: "No" as const,
      settlePriceScaled: 178_100_000_000_000_000_000n,
    };
    renderState(settledNo, config, CLOSE + 10 * 60);
    await settle();
    expect(reason()).toHaveTextContent(/^Settled NO at \$178\.10$/);
    expect(screen.getByRole("button", { name: "Redeem $8.00" })).toBeEnabled();
    expect(screen.getByText("Your 40 YES pay $0.00.")).toBeInTheDocument();
  });

  it("a wallet holding only losing tokens sees no Redeem button, only what they pay", async () => {
    const fake = fakeActions();
    render(
      <TradeView
        market={settledYes}
        config={config}
        nowSecs={CLOSE + 600}
        reader={fakeReader({ getWallet: () => Promise.resolve({ ...EMPTY_WALLET, no: 5n }) })}
        actions={fake.actions}
        wallet={USER}
        marketData={{ prices: {}, pricesUnavailable: [], books: {} }}
        fairValues={{ status: "loading", byMarket: {}, refreshFailed: false }}
        ladder={[]}
        explorerUrl={(s) => s}
        debounceMs={0}
      />,
    );
    expect(await screen.findByText("Your 5 NO pay $0.00.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Redeem/ })).toBeNull();
  });
});

describe("the badge and the countdown follow the same state (M2-06 AC6)", () => {
  it("Closed counts down to settlement", async () => {
    renderState(open, config, CLOSE + 60);
    await settle();
    expect(screen.getByText("Closed, settling at 16:05 ET")).toBeInTheDocument();
    expect(screen.getByText("Settling starts in")).toBeInTheDocument();
    expect(screen.getByText("04:00")).toBeInTheDocument();
  });

  it("Settled shows no countdown", async () => {
    renderState(settledYes, config, CLOSE + 600);
    await settle();
    expect(screen.getByText("Settled YES at $181.42", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByText(/in$/)).toBeNull();
  });
});
