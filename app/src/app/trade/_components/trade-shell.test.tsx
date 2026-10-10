import { PublicKey } from "@solana/web3.js";
import { render, screen, waitFor, configure } from "@testing-library/react";
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

import { NOT_FOUND_TEXT, TradeShell } from "./trade-shell";
import { TestMarketProvider } from "@/components/test-market-context";
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
  created.reader.mockClear();
});

function shell(address: string, listMarkets = () => Promise.resolve([ROW])) {
  return render(
    withReader(
      reader({ listMarkets }),
      <TestMarketProvider>
        <TradeShell address={address} />
      </TestMarketProvider>,
    ),
  );
}

describe("TradeShell", () => {
  it("shows the page for a known market address", async () => {
    shell(ROW.address);
    expect(screen.getByRole("status")).toHaveTextContent("Loading market…");
    expect(await screen.findByText(/^Will NVDA close at or above \$180\.00/)).toBeInTheDocument();
    expect(created.reader).toHaveBeenCalledTimes(1);
    expect(created.actions).not.toHaveBeenCalled(); // no wallet, nothing to sign with
  });

  it("builds the signing actions once a wallet that can sign is connected", async () => {
    wallet.publicKey = new PublicKey("11111111111111111111111111111112");
    wallet.signTransaction = vi.fn();
    shell(ROW.address);
    await screen.findByText(/^Will NVDA close at or above/);
    expect(created.actions).toHaveBeenCalled();
    expect(created.actions.mock.calls[0]?.[3]).toMatchObject({ address: ROW.address });
  });

  it("a wallet that cannot sign gets no signing actions", async () => {
    wallet.publicKey = new PublicKey("11111111111111111111111111111112");
    shell(ROW.address);
    await screen.findByText(/^Will NVDA close at or above/);
    expect(created.actions).not.toHaveBeenCalled();
  });

  it("says so for an address that is not a market", async () => {
    shell("NotAMarket");
    expect(await screen.findByRole("alert")).toHaveTextContent(NOT_FOUND_TEXT);
  });

  it("reports a markets read failure instead of a blank page", async () => {
    shell(ROW.address, () => Promise.reject(new Error("rpc down")));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load the market: rpc down",
    );
  });

  it("reports a config read failure", async () => {
    render(
      withReader(
        reader({ getConfig: () => Promise.reject(new Error("no config")) }),
        <TradeShell address={ROW.address} />,
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not load the configuration: no config",
      ),
    );
  });
});
