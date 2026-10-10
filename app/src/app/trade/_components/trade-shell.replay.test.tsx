import { PublicKey } from "@solana/web3.js";
import { render, screen, within, configure } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const wallet = vi.hoisted(() => ({
  publicKey: null as PublicKey | null,
  signTransaction: undefined as unknown,
}));
const created = vi.hoisted(() => ({ actions: vi.fn(), reader: vi.fn() }));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => wallet,
  useConnection: () => ({ connection: {} }),
}));
vi.mock("@/components/providers", () => ({
  Providers: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/wallet-button", () => ({ WalletButton: () => null }));
vi.mock("@/components/fair-value/ticker-insight", () => ({ TickerInsight: () => null }));
vi.mock("@/components/faucet-button", () => ({ FaucetButton: () => null }));
vi.mock("@/lib/market-data", () => ({
  useMarketData: () => ({ status: "ready", prices: {}, pricesUnavailable: [], books: {} }),
}));
vi.mock("../_lib/reader", () => ({
  createTradeReader: (...args: unknown[]) => {
    created.reader(...args);
    return {
      getBook: () => Promise.resolve({ bids: [], asks: [] }),
      getWallet: () => Promise.resolve({ yes: 0n, no: 0n, usdc: 0n, freeUsdc: 0n, freeYes: 0n }),
      getOpenTime: () => Promise.resolve(null),
    };
  },
}));
vi.mock("../_lib/tx", () => ({
  createTradeActions: (...args: unknown[]) => {
    created.actions(...args);
    return { simulate: () => new Promise(() => undefined) };
  },
}));

import { TradeShell } from "./trade-shell";
import { REPLAY_READ_ONLY_NOTE } from "@/components/replay-guard";
import { market, reader, withReader } from "@/test-utils";

// The shared dev box can be heavily loaded; generous waits keep these from flaking.
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 60_000 });

/** Unix seconds for a UTC ISO string. */
const utc = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const ROW = market({
  address: "MarketAddr1111111111111111111111111111111111",
  ticker: "NVDA",
  tradingDate: 20261008,
  strikeCents: 18_000n,
  closeTs: BigInt(utc("2026-10-08T20:00:00Z")), // Session close 16:00 ET
});

afterEach(() => {
  wallet.publicKey = null;
  wallet.signTransaction = undefined;
  created.actions.mockClear();
  window.history.pushState({}, "", "/");
});

const DEMO = market({
  address: "DemoAddr11111111111111111111111111111111111",
  ticker: "NVDA",
  tradingDate: 20261011, // Sunday: a demo-session market
  strikeCents: 18_000n,
  closeTs: BigInt(utc("2026-10-12T00:00:00Z")), // Sun Oct 11, 8:00 PM ET
});

function shell(address: string, rows = [ROW, DEMO]) {
  return render(
    withReader(
      reader({ listMarkets: () => Promise.resolve(rows) }),
      <TradeShell address={address} />,
    ),
  );
}

describe("TradeShell replay (read-only)", () => {
  it("disables every trade control and builds no signing actions", async () => {
    wallet.publicKey = new PublicKey("11111111111111111111111111111112");
    wallet.signTransaction = vi.fn();
    window.history.pushState({}, "", `/trade/${ROW.address}?replay=2026-10-08T10:30`);
    shell(ROW.address);
    expect(await screen.findByRole("note")).toHaveTextContent(REPLAY_READ_ONLY_NOTE);
    expect(await screen.findByTestId("replay-banner")).toHaveTextContent(
      "REPLAY · Thu Oct 8, 2026 10:30 AM ET · read-only",
    );
    const guard = screen.getByTestId("replay-guard");
    const buttons = within(guard).queryAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button).toBeDisabled();
    expect(created.actions).not.toHaveBeenCalled();
  });

  it("live: controls stay enabled and signing actions are built", async () => {
    wallet.publicKey = new PublicKey("11111111111111111111111111111112");
    wallet.signTransaction = vi.fn();
    shell(ROW.address);
    await screen.findByText(/^Will NVDA close at or above/);
    expect(screen.queryByTestId("replay-guard")).toBeNull();
    expect(created.actions).toHaveBeenCalled();
  });
});

describe("TradeShell demo market", () => {
  it("lists the demo market and shows the DEMO header with the on-chain close", async () => {
    shell(DEMO.address);
    const header = await screen.findByTestId("demo-market-header");
    expect(header).toHaveTextContent("DEMO · not a real market day");
    expect(header).toHaveTextContent("trading closes Sun Oct 11, 8:00 PM ET");
  });

  it("a real-session market's Trade page has no demo header", async () => {
    shell(ROW.address);
    await screen.findByText(/^Will NVDA close at or above/);
    expect(screen.queryByTestId("demo-market-header")).toBeNull();
    expect(screen.queryByTestId("demo-badge")).toBeNull();
  });
});
