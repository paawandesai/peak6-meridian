/**
 * P0-7: the demo moment on one Trade screen. Buy NO fills; the same book shows the fill in the YES
 * and the NO view; fair value and edge; the distribution chart; vault = $1 × pairs.
 */
import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { HIGHLIGHT_MS, NO_VIEW_CAPTION } from "./book-panel";
import { type TradeInsight, TradeView } from "./trade-view";
import type { FullBook } from "../_lib/book-view";
import type { TradeSnapshot } from "../_lib/reader";
import {
  BOOK,
  fakeActions,
  fakeReader,
  fills,
  order,
  USER,
  VAULT,
  MAKER_A,
  MAKER_B,
} from "../_lib/test-support";
import type { SimulationOutcome, TradeRequest } from "../_lib/tx";
import { DESKTOP_QUERY } from "@/components/distribution-chart/distribution-section";
import { fair } from "@/components/fair-value/test-support";
import type { AppConfig } from "@/lib/chain";
import { market } from "@/test-utils";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 60_000 });

const CLOSE = 1_791_489_600n; // 2026-10-08 16:00 ET
const OPEN_NOW = Number(CLOSE) - 3600;
const NVDA = market({
  address: "Mkt180".padEnd(44, "1"),
  ticker: "NVDA",
  strikeCents: 18_000n,
  tradingDate: 20261008,
  closeTs: CLOSE,
});
const NVDA_170 = market({ ...NVDA, address: "Mkt170".padEnd(44, "1"), strikeCents: 17_000n });
const NVDA_190 = market({ ...NVDA, address: "Mkt190".padEnd(44, "1"), strikeCents: 19_000n });
const config: AppConfig = { paused: false, overrideDelaySecs: 3600n, admin: "A" };

/** BOOK after a Buy NO of 10 fills against the 58¢ YES bid (30 → 20). */
const AFTER_BUY_NO: FullBook = {
  bids: [order("bid", 58, 20, MAKER_A, 1), order("bid", 57, 50, MAKER_B, 2)],
  asks: BOOK.asks,
};

const simulate = (request: TradeRequest): SimulationOutcome => ({
  ok: true,
  events: request.intent === "BUY_NO" ? fills([58, 10]) : fills([61, 10]),
});

const original = window.matchMedia;
beforeAll(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});
beforeEach(() => {
  // No live calls: the Pyth quote route answers "unavailable".
  global.fetch = vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: async () => ({ quotes: [], unavailable: ["NVDA"], server_time: Date.now() }),
    } as Response),
  );
});
afterEach(() => {
  window.matchMedia = original;
});

function desktop(): void {
  window.matchMedia = vi.fn((query: string) => ({
    matches: query === DESKTOP_QUERY,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function renderDemo(
  options: { snapshot?: () => Promise<TradeSnapshot>; insight?: TradeInsight } = {},
) {
  const fake = fakeActions(simulate);
  const reader = fakeReader(
    options.snapshot === undefined ? {} : { getSnapshot: options.snapshot },
  );
  render(
    <TradeView
      market={NVDA}
      config={config}
      nowSecs={OPEN_NOW}
      reader={reader}
      actions={fake.actions}
      wallet={USER}
      marketData={{ prices: {}, pricesUnavailable: ["NVDA"] }}
      explorerUrl={(signature) => `https://explorer.example/tx/${signature}`}
      debounceMs={0}
      {...(options.insight === undefined ? {} : { insight: options.insight })}
    />,
  );
  return fake;
}

const table = () => screen.getByTestId("book-table");
const row = (price: string) => within(table()).getByText(price).closest("tr");
const view = (name: "YES view" | "NO view") => fireEvent.click(screen.getByRole("radio", { name }));
const intents = () => screen.getByRole("radiogroup", { name: "What do you want to do?" });
const signButton = () => screen.getByRole("button", { name: /^Sign and/ });

describe("one book, both views (P0-7 AC1)", () => {
  it("the NO view lists the same levels mirrored at 100 − p, with the derived-NO caption", async () => {
    renderDemo();
    await screen.findByText("spread 3¢ · mid 59¢");
    const yesRows = [...table().querySelectorAll("tr[data-yes-level]")].map((tr) => [
      tr.getAttribute("data-yes-level"),
      tr.textContent,
    ]);
    expect(yesRows).toEqual([
      ["ask:62", "Asks62¢×25"],
      ["ask:61", "Asks61¢×40"],
      ["bid:58", "Bids58¢×30"],
      ["bid:57", "Bids57¢×50"],
    ]);
    view("NO view");
    expect(within(table()).getByText(NO_VIEW_CAPTION)).toBeInTheDocument();
    expect(screen.getByTestId("derived-no")).toHaveTextContent(
      "NO 41¢ = 100 − 59¢ YES; YES + NO = 100¢",
    );
    const noRows = [...table().querySelectorAll("tr[data-yes-level]")].map((tr) => [
      tr.getAttribute("data-yes-level"),
      tr.textContent,
    ]);
    // Same four levels (same YES keys and quantities), relabelled at 100 − p.
    expect(noRows).toEqual([
      ["bid:57", "NO asks43¢×50"],
      ["bid:58", "NO asks42¢×30"],
      ["ask:61", "NO bids39¢×40"],
      ["ask:62", "NO bids38¢×25"],
    ]);
  });

  it("draws depth bars sized to each level's share of the largest", async () => {
    renderDemo();
    await screen.findByText("spread 3¢ · mid 59¢");
    const widths = within(table())
      .getAllByTestId("depth-bar")
      .map((bar) => (bar as HTMLElement).style.width);
    expect(widths).toEqual(["50%", "80%", "60%", "100%"]); // 25, 40, 30, 50 of max 50
  });
});

describe("a Buy NO fill shows in both views (P0-7 AC2)", () => {
  it("highlights the changed level within 3 s in the YES view and in the NO view", async () => {
    let filled = false;
    const fake = renderDemo({
      snapshot: () => Promise.resolve({ book: filled ? AFTER_BUY_NO : BOOK, vault: VAULT }),
    });
    const trade = fake.actions.trade;
    fake.actions.trade = async (request, onPhase) => {
      const result = await trade(request, onPhase);
      filled = true; // the chain now holds the post-fill book
      return result;
    };
    await screen.findByText("spread 3¢ · mid 59¢");
    fireEvent.click(within(intents()).getByRole("radio", { name: /^Buy NO/ }));
    await screen.findByTestId("simulated");
    await waitFor(() => expect(signButton()).toBeEnabled());
    expect(signButton()).toHaveTextContent("Sign and buy NO");
    fireEvent.click(signButton());
    await screen.findByText("Confirmed in slot 123");
    const confirmedAt = Date.now();

    // YES view: the 58¢ bid went 30 → 20 and is marked.
    await waitFor(() => expect(row("58¢")).toHaveAttribute("data-changed", "true"));
    expect(Date.now() - confirmedAt).toBeLessThanOrEqual(3_000);
    expect(row("58¢")).toHaveTextContent("×20changed");
    expect(row("61¢")).not.toHaveAttribute("data-changed");

    // NO view: the same level is the 42¢ NO ask, marked too.
    view("NO view");
    expect(row("42¢")).toHaveAttribute("data-changed", "true");
    expect(row("42¢")).toHaveTextContent("NO asks42¢×20changed");
    expect(row("39¢")).not.toHaveAttribute("data-changed");
    expect(Date.now() - confirmedAt).toBeLessThanOrEqual(3_000);

    // The highlight clears after HIGHLIGHT_MS.
    await waitFor(() => expect(row("42¢")).not.toHaveAttribute("data-changed"), {
      timeout: HIGHLIGHT_MS + 3_000,
    });
  });

  it("an unchanged book marks nothing", async () => {
    renderDemo();
    await screen.findByText("spread 3¢ · mid 59¢");
    await new Promise((resolve) => setTimeout(resolve, 1_200)); // at least one more poll
    expect(table().querySelector("tr[data-changed]")).toBeNull();
  });
});

describe("fair value, distribution and the vault chip on Trade (P0-7 AC3–AC5)", () => {
  // Fresh on the page's clock (2 s old), so nothing is flagged stale unless a test says so.
  const asOf = new Date((OPEN_NOW - 2) * 1000).toISOString();
  const insight: TradeInsight = {
    ladder: [NVDA_190, NVDA, NVDA_170],
    books: {
      [NVDA_170.address]: {
        state: "ready",
        quotes: { yesBid: 70, yesAsk: 74, yesMid: 72, noPrice: 28 },
      },
      [NVDA_190.address]: { state: "unavailable" },
    },
    fair: {
      status: "ready",
      byMarket: {
        [NVDA.address]: fair({ market: NVDA.address, fair_cents: 62, as_of: asOf }),
        [NVDA_170.address]: fair({ market: NVDA_170.address, fair_cents: 70, as_of: asOf }),
      },
      lastSuccessSecs: OPEN_NOW - 1,
    },
  };

  it("shows this strike's fair value and edge next to the price, in words", async () => {
    renderDemo({ insight });
    await waitFor(() =>
      expect(screen.getByTestId("displayed-price")).toHaveTextContent("YES 59¢ · 59% · NO 41¢"),
    );
    expect(screen.getByTestId("price-fair")).toHaveTextContent("Fair 62¢ · Edge −3¢ (cheap)");
  });

  it("renders the ladder's distribution under the book with fair and edge per strike", async () => {
    desktop();
    renderDemo({ insight });
    const dist = await screen.findByTestId("distribution-table");
    await waitFor(() => {
      const rows = [...dist.querySelectorAll("tbody tr")].map((tr) => tr.textContent);
      expect(rows).toEqual([
        "$17072¢70¢Edge +2¢ (rich)",
        "$18059¢62¢Edge −3¢ (cheap)", // this strike, from its own full book
        "$190———",
      ]);
    });
  });

  it("shows a stale fair value flagged, not hidden, in the distribution table (P0-FV)", async () => {
    desktop();
    const stale: TradeInsight = {
      ...insight,
      fair: {
        ...insight.fair,
        byMarket: {
          ...insight.fair.byMarket,
          [NVDA_170.address]: fair({
            market: NVDA_170.address,
            fair_cents: 70,
            as_of: new Date((OPEN_NOW - 45) * 1000).toISOString(),
            stale: true,
          }),
        },
      },
    };
    renderDemo({ insight: stale });
    const dist = await screen.findByTestId("distribution-table");
    await waitFor(() => {
      const rows = [...dist.querySelectorAll("tbody tr")] as HTMLElement[];
      expect(rows[0]).toHaveTextContent("70¢stale");
      expect(within(rows[0] as HTMLElement).getByTestId("stale-tag")).toHaveAttribute(
        "title",
        expect.stringMatching(
          /^Spot as of \d\d:\d\d:\d\d ET; the pricing service flagged it stale$/,
        ),
      );
      // This strike's value is fresh: its row has no tag, nor does the price line.
      expect(rows[1]).not.toHaveTextContent("stale");
    });
    expect(screen.getByTestId("fair-edge")).toHaveAttribute("data-stale", "false");
    expect(screen.queryByTestId("fair-edge-missing")).toBeNull();
  });

  it("states plainly when the fair-value service has nothing", async () => {
    renderDemo();
    expect(await screen.findByTestId("fair-edge-missing")).toBeInTheDocument();
  });

  it("shows vault = pairs × $1.00 with a Pass, linking to /status", async () => {
    renderDemo();
    const chip = await screen.findByTestId("vault-chip");
    await waitFor(() =>
      expect(chip).toHaveTextContent(
        /^Vault 1,240\.00 test-USDC = 1,240 pairs × \$1\.00 ✓ Pass \(as of \d\d:\d\d:\d\d ET\)$/,
      ),
    );
    expect(chip).toHaveAttribute("href", "/status");
  });

  it("a vault that does not match reads Fail", async () => {
    renderDemo({
      snapshot: () => Promise.resolve({ book: BOOK, vault: { ...VAULT, balance: 1_239_999_999n } }),
    });
    await waitFor(() =>
      expect(screen.getByTestId("vault-chip")).toHaveAttribute("data-verdict", "Fail"),
    );
    expect(screen.getByTestId("vault-chip")).toHaveTextContent("≠ 1,240 pairs × $1.00 ✕ Fail");
  });
});
