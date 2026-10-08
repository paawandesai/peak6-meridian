import { act, fireEvent, render, screen, waitFor, within, configure } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TradeView } from "./trade-view";
import { NO_VIEW_CAPTION } from "./book-panel";
import type { Intent } from "@meridian/client";
import type { WalletView } from "../_lib/reader";
import {
  BOOK,
  EMPTY_WALLET,
  fakeActions,
  fakeReader,
  fills,
  MAKER_A,
  order,
  USER,
} from "../_lib/test-support";
import type { SimulationOutcome, TradeRequest } from "../_lib/tx";
import type { AppConfig } from "@/lib/chain";
import { market } from "@/test-utils";

// The shared dev box can be heavily loaded; generous waits keep these from flaking.
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 60_000 });

// 2026-10-08 16:00 ET close = 20:00Z.
const CLOSE = 1_791_489_600n;
const NVDA = market({
  ticker: "NVDA",
  strikeCents: 18_000n,
  tradingDate: 20261008,
  closeTs: CLOSE,
});
const config: AppConfig = { paused: false, overrideDelaySecs: 3600n, admin: "A" };
const OPEN_NOW = Number(CLOSE) - 3600;

/** What each intent fills against BOOK (bids 58, 57 · asks 61, 62). */
function simulate(request: TradeRequest): SimulationOutcome {
  const events = {
    BUY_YES: fills([61, 10]),
    BUY_NO: fills([58, 10]),
    SELL_YES: fills([58, 10]),
    SELL_NO: fills([61, 10]),
  }[request.intent];
  return { ok: true, events };
}

type Overrides = {
  wallet?: WalletView;
  actions?: ReturnType<typeof fakeActions>;
  book?: typeof BOOK;
  nowSecs?: number;
  cfg?: AppConfig;
  m?: ReturnType<typeof market>;
  openTime?: number | null;
  noWallet?: boolean;
  prices?: Parameters<typeof TradeView>[0]["marketData"];
};

function renderView(o: Overrides = {}) {
  const fake = o.actions ?? fakeActions(simulate);
  const result = render(
    <TradeView
      market={o.m ?? NVDA}
      config={o.cfg ?? config}
      nowSecs={o.nowSecs ?? OPEN_NOW}
      reader={fakeReader({
        getWallet: () => Promise.resolve(o.wallet ?? EMPTY_WALLET),
        getBook: () => Promise.resolve(o.book ?? BOOK),
        getOpenTime: () => Promise.resolve(o.openTime ?? null),
      })}
      actions={o.noWallet ? null : fake.actions}
      wallet={o.noWallet ? null : USER}
      marketData={o.prices ?? { prices: {}, pricesUnavailable: ["NVDA"] }}
      explorerUrl={(signature) => `https://explorer.example/tx/${signature}`}
      debounceMs={0}
    />,
  );
  return { ...result, fake };
}

const intentGroup = () => screen.getByRole("radiogroup", { name: "What do you want to do?" });
const intentRadio = (name: string) => within(intentGroup()).getByRole("radio", { name });
async function pick(label: string) {
  fireEvent.click(within(intentGroup()).getByRole("radio", { name: new RegExp(`^${label}`) }));
}
const signButton = () => screen.getByRole("button", { name: /^Sign and/ });

describe("the four intents (UI-04 AC1)", () => {
  it("shows all four, in domain order, each with an outcome sub-label", async () => {
    renderView();
    const radios = within(intentGroup()).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual([
      "Buy YESwins if ≥ $180",
      "Buy NOwins if < $180",
      "Sell YESexit YES",
      "Sell NOexit NO",
    ]);
    await screen.findByText("spread 3¢ · mid 59¢");
  });

  it("gives Buy NO the same size and weight as Buy YES", async () => {
    renderView();
    fireEvent.click(intentRadio("Sell YESexit YES")); // neither buy intent selected
    const yes = intentRadio("Buy YESwins if ≥ $180");
    const no = intentRadio("Buy NOwins if < $180");
    expect(no.className).toBe(yes.className);
    expect(no.tagName).toBe(yes.tagName);
    await screen.findByTestId("simulated");
  });
});

describe("simulate, then sign (AC2)", () => {
  it("keeps Sign disabled until the simulation succeeds, with the payoff sentence before signing", async () => {
    let release: (outcome: SimulationOutcome) => void = () => undefined;
    const pending = new Promise<SimulationOutcome>((resolve) => {
      release = resolve;
    });
    const fake = fakeActions(simulate);
    fake.actions.simulate = () => pending;
    renderView({ actions: fake });
    expect(await screen.findByText("Simulating…")).toBeInTheDocument();
    expect(signButton()).toBeDisabled();
    expect(screen.queryByTestId("simulated")).toBeNull();
    await act(async () => release(simulate({ intent: "BUY_YES" } as TradeRequest)));
    const sentence = await screen.findByText(/^You pay \$6\.10 for 10 contracts\./);
    expect(sentence).toBeInTheDocument();
    expect(signButton()).toBeEnabled();
    // Order on the page: the sentence is above the sign button.
    expect(
      sentence.compareDocumentPosition(signButton()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("stays disabled when the simulation fails and says nothing was charged", async () => {
    renderView({
      actions: fakeActions({ ok: false, reason: "Trading is paused: no minting or new orders" }),
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed: Trading is paused: no minting or new orders. Nothing was charged.",
    );
    expect(signButton()).toBeDisabled();
    expect(screen.queryByTestId("simulated")).toBeNull();
  });

  it("stays disabled when nothing would fill (empty book, market order)", async () => {
    renderView({ actions: fakeActions({ ok: true, events: [] }) });
    fireEvent.click(screen.getByLabelText("Market"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/nothing would fill/);
    expect(signButton()).toBeDisabled();
  });

  it("stays disabled for an invalid quantity or price and says why", async () => {
    const fake = fakeActions(simulate);
    renderView({ actions: fake });
    await screen.findByTestId("simulated");
    fireEvent.change(screen.getByLabelText(/Quantity/), { target: { value: "0" } });
    expect(
      await screen.findByText("Enter a whole number of contracts, at least 1."),
    ).toBeInTheDocument();
    expect(signButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Quantity/), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(/Price/), { target: { value: "100" } });
    expect(await screen.findByText("Enter a price in whole cents, 1 to 99.")).toBeInTheDocument();
    expect(signButton()).toBeDisabled();
  });

  it("without a wallet nothing is simulated and Sign is disabled", async () => {
    const fake = fakeActions(simulate);
    renderView({ actions: fake, noWallet: true });
    expect(
      await screen.findByText("Connect a wallet to see what you pay and win."),
    ).toBeInTheDocument();
    expect(signButton()).toBeDisabled();
    expect(fake.calls.filter((c) => c.name === "simulate")).toHaveLength(0);
  });

  it("re-simulates when the quantity changes and never enables Sign from the old result", async () => {
    const fake = fakeActions(simulate);
    renderView({ actions: fake });
    await screen.findByTestId("simulated");
    fireEvent.change(screen.getByLabelText(/Quantity/), { target: { value: "7" } });
    expect(signButton()).toBeDisabled(); // stale result is not shown for the new input
    await waitFor(() => expect(signButton()).toBeEnabled());
    expect(fake.calls.filter((c) => c.name === "simulate").length).toBeGreaterThanOrEqual(2);
  });
});

describe.each<[Intent, string, string, string[]]>([
  [
    "BUY_YES",
    "Buy YES",
    "You pay $6.10 for 10 contracts. You win $10.00 (profit $3.90) if NVDA closes at or above $180 today. Max loss $6.10.",
    [
      "You pay$6.10",
      "Pays if right$10.00",
      "Profit if right$3.90",
      "Fees$0.00(network fee in devnet SOL)",
    ],
  ],
  [
    "BUY_NO",
    "Buy NO",
    "You pay $4.20 for 10 contracts. You win $10.00 (profit $5.80) if NVDA closes below $180 today. Max loss $4.20.",
    [
      "You pay$4.20",
      "Pays if right$10.00",
      "Profit if right$5.80",
      "Fees$0.00(network fee in devnet SOL)",
    ],
  ],
  [
    "SELL_YES",
    "Sell YES",
    "You receive $5.80 for selling 10 YES contracts. You give up $10.00 if NVDA closes at or above $180 today.",
    ["You receive$5.80", "Gives up if right$10.00", "Fees$0.00(network fee in devnet SOL)"],
  ],
  [
    "SELL_NO",
    "Sell NO",
    "You receive $3.90 for selling 10 NO contracts. You give up $10.00 if NVDA closes below $180 today.",
    ["You receive$3.90", "Gives up if right$10.00", "Fees$0.00(network fee in devnet SOL)"],
  ],
])(
  "%s: one transaction, one signature, cost strip (AC1, UI-04 AC9)",
  (intent, label, sentence, strip) => {
    it("simulates, shows the labelled amounts, and signs exactly once", async () => {
      const { fake } = renderView();
      await pick(label);
      await screen.findByTestId("simulated");
      expect(screen.getByText(sentence)).toBeInTheDocument();
      const items = [...screen.getByTestId("cost-strip").children].map((el) => el.textContent);
      expect(items).toEqual(strip);
      await waitFor(() => expect(signButton()).toBeEnabled());
      expect(signButton()).toHaveTextContent(
        `Sign and ${label.toLowerCase().replace("yes", "YES").replace("no", "NO")}`,
      );
      fireEvent.click(signButton());
      expect(await screen.findByText("Confirmed in slot 123")).toBeInTheDocument();
      const trades = fake.calls.filter((c) => c.name === "trade");
      expect(trades).toHaveLength(1);
      expect((trades[0]?.args[0] as TradeRequest).intent).toBe(intent);
      expect(screen.getByRole("link", { name: /view on explorer/ })).toHaveAttribute(
        "href",
        "https://explorer.example/tx/SigFake",
      );
    });
  },
);

describe("a failed send", () => {
  it("shows the reason and that nothing was charged, and can be retried", async () => {
    const fake = fakeActions(simulate);
    fake.actions.trade = () => Promise.reject(new Error("User rejected the request"));
    renderView({ actions: fake });
    await waitFor(() => expect(signButton()).toBeEnabled());
    fireEvent.click(signButton());
    expect(
      await screen.findByText("Failed: User rejected the request. Nothing was charged."),
    ).toBeInTheDocument();
    await waitFor(() => expect(signButton()).toBeEnabled());
  });

  it("falls back to a plain message for an error without text", async () => {
    const fake = fakeActions(simulate);
    fake.actions.trade = () => Promise.reject(new Error(" "));
    renderView({ actions: fake });
    await waitFor(() => expect(signButton()).toBeEnabled());
    fireEvent.click(signButton());
    expect(
      await screen.findByText("Failed: the order was not sent. Nothing was charged."),
    ).toBeInTheDocument();
  });
});

describe("limit and market (FR-17)", () => {
  it("starts with a limit that crosses the best order and sends a limit request", async () => {
    const { fake } = renderView();
    await waitFor(() => expect(screen.getByLabelText(/Price/)).toHaveValue("61"));
    await waitFor(() => expect(signButton()).toBeEnabled());
    fireEvent.click(signButton());
    await screen.findByText("Confirmed in slot 123");
    const sent = fake.calls.find((c) => c.name === "trade")?.args[0] as TradeRequest;
    expect([sent.kind, sent.priceCents, sent.qty]).toEqual(["limit", 61, 10n]);
  });

  it("a market order is an IOC at the worst price, 99 to buy and 1 to sell", async () => {
    const { fake } = renderView();
    fireEvent.click(screen.getByLabelText("Market"));
    expect(screen.getByLabelText(/Worst price/)).toHaveValue("99");
    await waitFor(() => expect(signButton()).toBeEnabled());
    fireEvent.click(signButton());
    await screen.findByText("Confirmed in slot 123");
    expect((fake.calls.find((c) => c.name === "trade")?.args[0] as TradeRequest).kind).toBe("ioc");
    await pick("Sell YES"); // stays a market order
    expect(screen.getByLabelText(/Worst price/)).toHaveValue("1");
    fireEvent.click(screen.getByLabelText("Limit")); // a limit starts at the best bid
    expect(screen.getByLabelText(/Price/)).toHaveValue("58");
  });

  it("Sell NO is immediate-or-cancel only: the limit choice is disabled", async () => {
    renderView();
    await pick("Sell NO");
    expect(screen.getByLabelText("Limit")).toBeDisabled();
    expect(screen.getByLabelText("Market")).toBeChecked();
    expect(screen.getByText(/fills now or not at all/)).toBeInTheDocument();
    await waitFor(() => expect(signButton()).toBeEnabled());
  });
});

describe("position constraint (AC3, UI-04 AC2)", () => {
  const holdingNo: WalletView = { ...EMPTY_WALLET, no: 12n };
  const holdingYes: WalletView = { ...EMPTY_WALLET, yes: 3n };

  it("a NO holder sees the notice in place of Buy YES, with Sell NO preselected as the exit", async () => {
    const { fake } = renderView({ wallet: holdingNo });
    const block = await screen.findByTestId("constraint-block");
    expect(block).toHaveTextContent("You hold 12 NO on this strike. Sell NO first to buy YES.");
    expect(screen.queryByLabelText(/Quantity/)).toBeNull(); // the form is replaced
    expect(signButton()).toBeDisabled();
    expect(fake.calls.filter((c) => c.name === "simulate")).toHaveLength(0);
    fireEvent.click(within(block).getByRole("button", { name: "Sell NO" }));
    expect(intentRadio("Sell NOexit NO")).toBeChecked();
    expect(screen.getByLabelText(/Quantity/)).toHaveValue("12");
    expect(screen.queryByTestId("constraint-block")).toBeNull();
  });

  it("a YES holder sees the notice in place of Buy NO, with Sell YES as the exit", async () => {
    renderView({ wallet: holdingYes });
    await screen.findByTestId("simulated").catch(() => undefined);
    await pick("Buy NO");
    const block = await screen.findByTestId("constraint-block");
    expect(block).toHaveTextContent("You hold 3 YES on this strike. Sell YES first to buy NO.");
    fireEvent.click(within(block).getByRole("button", { name: "Sell YES" }));
    expect(intentRadio("Sell YESexit YES")).toBeChecked();
    expect(screen.getByLabelText(/Quantity/)).toHaveValue("3");
  });

  it("the blocked intent stays visible and explains itself on hover and inline", async () => {
    renderView({ wallet: holdingNo });
    await screen.findByTestId("constraint-block");
    const buyYes = intentRadio("Buy YESblocked: you hold NO");
    expect(buyYes).toHaveAttribute(
      "title",
      "You hold 12 NO on this strike. Sell NO first to buy YES.",
    );
    expect(intentRadio("Sell NOexit NO")).toBeEnabled();
  });

  it("a resting limit Buy NO gets its own exception text and no exit button", async () => {
    const book = {
      bids: BOOK.bids,
      asks: [...BOOK.asks, order("ask", 60, 10, USER, 9)],
    };
    renderView({ wallet: holdingNo, book });
    const block = await screen.findByTestId("constraint-block");
    expect(block).toHaveTextContent(
      "Your limit Buy NO is resting; you hold YES in escrow until it fills.",
    );
    expect(within(block).queryByRole("button")).toBeNull();
    // The resting order can be cancelled from the list below.
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });
});

describe("the book (UI-04 AC4, AC9)", () => {
  it("YES view lists bids and asks and the spread line names the midpoint", async () => {
    renderView();
    expect(await screen.findByText("spread 3¢ · mid 59¢")).toBeInTheDocument();
    const table = screen.getByTestId("book-table");
    expect(within(table).getByText("61¢").closest("tr")).toHaveAttribute("data-side", "ask");
    expect(within(table).getByText("58¢").closest("tr")).toHaveAttribute("data-side", "bid");
  });

  it("NO view shows YES asks as NO bids at 100 − p, with a caption", async () => {
    renderView();
    await screen.findByText("spread 3¢ · mid 59¢");
    fireEvent.click(screen.getByRole("radio", { name: "NO view" }));
    const table = screen.getByTestId("book-table");
    expect(within(table).getByText(NO_VIEW_CAPTION)).toBeInTheDocument();
    const bids = [...table.querySelectorAll('tr[data-side="bid"]')].map((tr) => tr.textContent);
    expect(bids).toEqual(["NO bids39¢×40", "NO bids38¢×25"]); // YES asks 61, 62
    const asks = [...table.querySelectorAll('tr[data-side="ask"]')].map((tr) => tr.textContent);
    expect(asks).toEqual(["NO asks43¢×50", "NO asks42¢×30"]); // YES bids 57, 58
  });

  it("the derived-NO line is a template over the live price (two different books)", async () => {
    const first = renderView();
    expect(await screen.findByTestId("derived-no")).toHaveTextContent(
      "NO 41¢ = 100 − 59¢ YES; YES + NO = 100¢",
    );
    first.unmount();
    renderView({ book: { bids: [order("bid", 70, 5)], asks: [order("ask", 72, 5)] } });
    await waitFor(() =>
      expect(screen.getByTestId("derived-no")).toHaveTextContent(
        "NO 29¢ = 100 − 71¢ YES; YES + NO = 100¢",
      ),
    );
  });

  it("says plainly when the book is empty", async () => {
    renderView({ book: { bids: [], asks: [] } });
    expect(await screen.findByText("No resting orders")).toBeInTheDocument();
    expect(screen.getByTestId("derived-no")).toHaveTextContent("NO = 100 − YES; YES + NO = 100¢");
  });

  it("says a side is empty when the spread cannot be computed", async () => {
    renderView({ book: { bids: [], asks: [order("ask", 61, 1)] } });
    expect(await screen.findByText("no spread: one side is empty")).toBeInTheDocument();
  });

  it("a book that cannot be read is reported, not guessed", async () => {
    const view = render(
      <TradeView
        market={NVDA}
        config={config}
        nowSecs={OPEN_NOW}
        reader={fakeReader({ getBook: () => Promise.reject(new Error("rpc down")) })}
        actions={null}
        wallet={null}
        marketData={{ prices: {}, pricesUnavailable: [] }}
        explorerUrl={() => ""}
      />,
    );
    expect(await screen.findByText(/Could not read the book: rpc down/)).toBeInTheDocument();
    view.unmount();
  });
});

describe("the page header (UI-04 AC9, AC10, M2-06 AC6)", () => {
  it("the question is the H1 and carries the time in ET", async () => {
    renderView();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Will NVDA close at or above $180.00 at today's 16:00 ET close?",
    );
    await screen.findByTestId("simulated");
  });

  it("shows the settlement rule and the timeline for a normal close", async () => {
    renderView();
    expect(
      screen.getByText(
        "Settles on the average of two official closing prices (Tiingo and Twelve Data) for 2026-10-08. YES wins at or above $180.00, NO wins below.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Trading stops 16:00 ET · Settlement about 16:05 ET · Redeem after settlement",
      ),
    ).toBeInTheDocument();
    await screen.findByTestId("simulated");
  });

  it("shows 13:00 ET for an early close", async () => {
    const early = market({
      ticker: "NVDA",
      strikeCents: 18_000n,
      tradingDate: 20261008,
      closeTs: CLOSE - 3n * 3600n,
    });
    renderView({ m: early, nowSecs: Number(early.closeTs) - 3600 });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "at today's 13:00 ET close?",
    );
    expect(
      screen.getByText(
        "Trading stops 13:00 ET · Settlement about 13:05 ET · Redeem after settlement",
      ),
    ).toBeInTheDocument();
    await screen.findByTestId("simulated");
  });

  it("shows the open and close time in ET, the state badge and the countdown to close", async () => {
    renderView({ openTime: 1_791_462_600 }); // 08:30 ET
    await waitFor(() =>
      expect(screen.getByTestId("open-close")).toHaveTextContent(
        "Opened 08:30 ET · Closes 16:00 ET",
      ),
    );
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("Closes in")).toBeInTheDocument();
    expect(screen.getByText("1:00:00")).toBeInTheDocument();
    await screen.findByTestId("simulated");
  });

  it("an unreadable creation time reads — and does not block anything", async () => {
    renderView({ openTime: null });
    await waitFor(() =>
      expect(screen.getByTestId("open-close")).toHaveTextContent("Opened — · Closes 16:00 ET"),
    );
    await screen.findByTestId("simulated");
  });

  it("shows Closing soon with a live remaining time in the badge", async () => {
    renderView({ nowSecs: Number(CLOSE) - 90 });
    expect(screen.getByText("Closes in 01:30")).toBeInTheDocument();
    await screen.findByTestId("simulated");
  });

  it("shows the live price with its as-of time, or says it is unavailable", async () => {
    const asOf = new Date((OPEN_NOW - 3) * 1000).toISOString();
    const first = renderView({
      prices: {
        prices: { NVDA: { ticker: "NVDA", price_cents: 18_142, as_of: asOf, stale: false } },
        pricesUnavailable: [],
      },
    });
    expect(screen.getByText("NVDA $181.42")).toBeInTheDocument();
    expect(screen.getByText(/^as of \d\d:\d\d:\d\d ET$/)).toBeInTheDocument();
    first.unmount();
    renderView();
    expect(screen.getByText("NVDA price unavailable")).toBeInTheDocument();
  });

  it("explains the midpoint in always-visible text", async () => {
    renderView();
    expect(screen.getByText(/Prices are the midpoint of the best bid and ask/)).toBeInTheDocument();
    await screen.findByTestId("simulated");
  });

  it("explains YES and NO once", async () => {
    renderView();
    expect(screen.getByText("pays $1.00 if NVDA closes at or above $180")).toBeInTheDocument();
    expect(screen.getByText("pays $1.00 if NVDA closes below $180")).toBeInTheDocument();
    await screen.findByTestId("simulated");
  });
});

describe("keyboard-only trade flow (UI-04 AC5)", () => {
  it("every control is a native, tabbable element in reading order, and Enter in the form signs once", async () => {
    const { container, fake } = renderView();
    await waitFor(() => expect(signButton()).toBeEnabled());
    const tabbable = [
      ...container.querySelectorAll<HTMLElement>(
        "button, input, a[href], select, textarea, [tabindex]",
      ),
    ].filter((el) => !(el as HTMLButtonElement).disabled);
    expect(tabbable.every((el) => el.getAttribute("tabindex") !== "-1")).toBe(true);
    const labels = tabbable.map(
      (el) => el.getAttribute("aria-label") ?? el.textContent ?? el.getAttribute("type"),
    );
    const order = ["Buy YES", "Buy NO", "Sell YES", "Sell NO"].map((l) =>
      labels.findIndex((t) => t?.startsWith(l)),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const form = signButton().closest("form") as HTMLFormElement;
    expect(signButton()).toHaveAttribute("type", "submit");
    fireEvent.submit(form); // Enter in a field submits the form
    await screen.findByText("Confirmed in slot 123");
    expect(fake.calls.filter((c) => c.name === "trade")).toHaveLength(1);
  });

  it("a submit while Sign is disabled does nothing", async () => {
    const fake = fakeActions({ ok: false, reason: "x" });
    renderView({ actions: fake });
    await screen.findByRole("alert");
    fireEvent.submit(signButton().closest("form") as HTMLFormElement);
    expect(fake.calls.filter((c) => c.name === "trade")).toHaveLength(0);
  });
});

describe("your orders and balances", () => {
  it("lists a resting order with Cancel, and cancels it with one transaction", async () => {
    const book = { bids: [...BOOK.bids, order("bid", 50, 4, USER, 9)], asks: BOOK.asks };
    const { fake } = renderView({ book });
    expect(await screen.findByText("Resting YES bid: 4 at 50¢")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Confirmed in slot 123")).toBeInTheDocument();
    expect(fake.calls.filter((c) => c.name === "cancel").map((c) => c.args[0])).toEqual([9n]);
  });

  it("offers Withdraw for a free balance and Redeem pairs for a wallet holding both", async () => {
    const { fake } = renderView({
      wallet: { ...EMPTY_WALLET, yes: 5n, no: 8n, freeUsdc: 2_500_000n, freeYes: 3n },
    });
    expect(await screen.findByText("Free balance: 2.50 test-USDC and 3 YES")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    await screen.findByText("Confirmed in slot 123");
    fireEvent.click(screen.getByRole("button", { name: "Redeem 5 pairs for $5.00" }));
    await waitFor(() => expect(fake.calls.some((c) => c.name === "redeemPair")).toBe(true));
    expect(fake.calls.find((c) => c.name === "redeemPair")?.args).toEqual([5n]);
    expect(fake.calls.some((c) => c.name === "withdraw")).toBe(true);
  });

  it("a failing recovery action shows the failure", async () => {
    const fake = fakeActions(simulate);
    fake.actions.withdraw = () => Promise.reject(new Error("boom"));
    renderView({ actions: fake, wallet: { ...EMPTY_WALLET, freeYes: 1n } });
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    expect(await screen.findByText("Failed: boom. Nothing was charged.")).toBeInTheDocument();
  });

  it("a failure without text falls back to a plain message", async () => {
    const fake = fakeActions(simulate);
    fake.actions.withdraw = () => Promise.reject(new Error(""));
    renderView({ actions: fake, wallet: { ...EMPTY_WALLET, freeYes: 1n } });
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    expect(
      await screen.findByText("Failed: the transaction was not sent. Nothing was charged."),
    ).toBeInTheDocument();
  });

  it("shows nothing when the wallet has nothing to act on", async () => {
    renderView();
    await screen.findByTestId("simulated");
    expect(screen.queryByRole("heading", { name: "Your orders and balances" })).toBeNull();
    void MAKER_A;
  });
});
