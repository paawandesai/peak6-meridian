/**
 * P1-2 RPC budget harness: counts every RPC request a realistic Trade page (11 strikes in the
 * ladder, a connected wallet) and Markets page (7 tickers × 11 strikes) make in one minute,
 * against a counting fake Connection. "Before" is the pre-P1-2 wiring, still present as the
 * fallback path: a reader and book sources without account subscriptions, so every reader polls
 * on its own timer (book + vault 1 s, wallet 2 s, ladder books 2 s). "After" is the same pages
 * with the shared account feed, once with a working pubsub socket (push) and once without one
 * (poll fallback). Acceptance (issue #62): RPC/min at least halves; updates show within 1 s.
 */
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAccountFeed, type AccountFeed } from "./account-feed";
import { type ConnectSocket, createAccountSocket } from "./account-socket";
import { parsePublicConfig } from "./config";
import { createMarketDataSources, type MarketDataSources, useMarketData } from "./market-data";
import type { MarketRow } from "./markets";
import { connectionFetcher } from "./rpc";
import { TradeView } from "@/app/trade/_components/trade-view";
import { createTradeReader, type TradeReader } from "@/app/trade/_lib/reader";
import { fakeChain, pdaMarket, WALLET_OWNER } from "@/app/trade/_lib/test-support";
import type { AppConfig } from "@/lib/chain";
import { useNow } from "@/components/use-now";
import { type FairValues } from "@/lib/fair-values";

// jsdom swaps in its own Uint8Array, which @noble/hashes rejects for Node Buffers, so PDA
// derivation fails under jsdom; restore Node's for these chain-backed renders.
const NodeUint8Array: typeof Uint8Array = Object.getPrototypeOf(Buffer.prototype).constructor;

const config = parsePublicConfig({
  rpcUrl: "http://127.0.0.1:8899",
  usdcMint: "GKuoE1akZCNnA4ouVdB6P3ngSnanBM28oydPS54fSnT5",
});
const APP_CONFIG: AppConfig = { paused: false, overrideDelaySecs: 3600n, admin: "A" };
const NO_FAIR: FairValues = { status: "unavailable", byMarket: {}, refreshFailed: false };
const NOW_SECS = 1_900_000_000; // every market below is open (close 2_000_000_000)
const TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] as const;
const strikes = (ticker: string): MarketRow[] =>
  Array.from({ length: 11 }, (_, i) => pdaMarket(config, ticker, BigInt(17_000 + i * 1_000)));

type Mode = "before" | "push" | "fallback";

/** A pubsub server that opens at once and confirms every subscription. */
function autoServer(): { connect: ConnectSocket; push: (key: string, bytes: Buffer) => void } {
  const subs = new Map<string, number>();
  let onMessage: (data: string) => void = () => undefined;
  let next = 1;
  const connect: ConnectSocket = (_url, handlers) => {
    onMessage = handlers.onMessage;
    queueMicrotask(handlers.onOpen);
    return {
      send: (raw) => {
        const message = JSON.parse(raw) as { id?: number; method: string; params: unknown[] };
        if (message.method !== "accountSubscribe") return;
        const id = next;
        next += 1;
        subs.set(String(message.params[0]), id);
        queueMicrotask(() =>
          handlers.onMessage(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: id })),
        );
      },
      close: () => undefined,
    };
  };
  const push = (key: string, bytes: Buffer) => {
    const subscription = subs.get(key);
    if (subscription === undefined) throw new Error(`not subscribed: ${key}`);
    onMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "accountNotification",
        params: {
          subscription,
          result: {
            context: { slot: 10_000 },
            value: { lamports: 1, data: [bytes.toString("base64"), "base64"] },
          },
        },
      }),
    );
  };
  return { connect, push };
}

let feeds: AccountFeed[] = [];

async function wiring(mode: Mode, rows: readonly MarketRow[]) {
  const chain = await fakeChain(config, rows);
  const server = autoServer();
  const feed = createAccountFeed({
    fetchMany: connectionFetcher(chain.connection),
    socket:
      mode === "push" ? createAccountSocket("wss://rpc.test/", { connect: server.connect }) : null,
  });
  feeds.push(feed);
  const live = createMarketDataSources({ config, connection: chain.connection, feed });
  const sources: MarketDataSources =
    mode === "before" ? { fetchPrices: live.fetchPrices, fetchBooks: live.fetchBooks } : live;
  const readerFor = (row: MarketRow): TradeReader => {
    const reader = createTradeReader(config, row, { connection: chain.connection, feed });
    return mode === "before"
      ? {
          getBook: reader.getBook,
          getSnapshot: reader.getSnapshot,
          getWallet: reader.getWallet,
          getOpenTime: reader.getOpenTime,
        }
      : reader;
  };
  return { chain, server, sources, readerFor };
}

function TradePage(props: {
  readonly reader: TradeReader;
  readonly sources: MarketDataSources;
  readonly ladder: readonly MarketRow[];
  readonly market: MarketRow;
  readonly wallet: PublicKey | null;
}) {
  // Mirrors trade-shell: the ladder's quotes for the chart plus the Trade view's own reads.
  const marketData = useMarketData(props.ladder, props.sources);
  const nowSecs = useNow() ?? NOW_SECS;
  return (
    <TradeView
      market={props.market}
      config={APP_CONFIG}
      nowSecs={nowSecs}
      reader={props.reader}
      actions={null}
      wallet={props.wallet}
      marketData={marketData}
      explorerUrl={() => ""}
      insight={{ ladder: props.ladder, books: marketData.books, fair: NO_FAIR }}
    />
  );
}

async function measureTrade(mode: Mode, wallet: PublicKey | null) {
  const ladder = strikes("NVDA");
  const market = ladder[5] as MarketRow;
  const { chain, sources, readerFor } = await wiring(mode, ladder);
  const view = render(
    <TradePage
      reader={readerFor(market)}
      sources={sources}
      ladder={ladder}
      market={market}
      wallet={wallet}
    />,
  );
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  const result = { total: chain.counts.total, byMethod: { ...chain.counts.byMethod } };
  view.unmount();
  return result;
}

async function measureMarkets(mode: Mode) {
  const rows = TICKERS.flatMap(strikes);
  const { chain, sources } = await wiring(mode, rows);
  const hook = renderHook(() => useMarketData(rows, sources));
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  const result = { total: chain.counts.total, byMethod: { ...chain.counts.byMethod } };
  hook.unmount();
  return result;
}

const report = (line: string) => process.stderr.write(`[rpc-budget] ${line}\n`);

beforeEach(() => {
  vi.stubGlobal("Uint8Array", NodeUint8Array);
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SECS * 1000);
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      const body = String(url).includes("/api/pyth-quotes")
        ? { quotes: [], unavailable: [], server_time: NOW_SECS * 1000 }
        : { prices: [], unavailable: [] };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }),
  );
});
afterEach(() => {
  for (const feed of feeds) feed.dispose();
  feeds = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RPC budget (P1-2, issue #62)", () => {
  it("Trade (11-strike ladder, wallet connected): push at least halves RPC/min; the fallback never adds", async () => {
    const before = await measureTrade("before", WALLET_OWNER);
    const push = await measureTrade("push", WALLET_OWNER);
    const fallback = await measureTrade("fallback", WALLET_OWNER);
    report(`trade+wallet before=${before.total}/min ${JSON.stringify(before.byMethod)}`);
    report(`trade+wallet push=${push.total}/min ${JSON.stringify(push.byMethod)}`);
    report(`trade+wallet fallback=${fallback.total}/min ${JSON.stringify(fallback.byMethod)}`);
    expect(before.total).toBeGreaterThanOrEqual(120); // 61 snapshot + 31 wallet + 31 ladder (+ open time)
    expect(push.total).toBeLessThanOrEqual(before.total / 2);
    expect(fallback.total).toBeLessThanOrEqual(before.total / 2 + 5); // one batched read per second
  });

  it("Trade (no wallet): push at least halves RPC/min; the fallback never adds", async () => {
    const before = await measureTrade("before", null);
    const push = await measureTrade("push", null);
    const fallback = await measureTrade("fallback", null);
    report(
      `trade before=${before.total}/min push=${push.total}/min fallback=${fallback.total}/min`,
    );
    expect(push.total).toBeLessThanOrEqual(before.total / 2);
    expect(fallback.total).toBeLessThanOrEqual(before.total);
  });

  it("Markets (7 tickers × 11 strikes): push at least halves RPC/min; the fallback never adds", async () => {
    const before = await measureMarkets("before");
    const push = await measureMarkets("push");
    const fallback = await measureMarkets("fallback");
    report(
      `markets before=${before.total}/min push=${push.total}/min fallback=${fallback.total}/min`,
    );
    expect(push.total).toBeLessThanOrEqual(before.total / 2);
    expect(fallback.total).toBeLessThanOrEqual(before.total);
  });
});

describe("update latency (P1-2: <= 1 s)", () => {
  async function renderTrade(mode: Exclude<Mode, "before">) {
    const ladder = strikes("NVDA");
    const market = ladder[5] as MarketRow;
    const made = await wiring(mode, ladder);
    render(
      <TradePage
        reader={made.readerFor(market)}
        sources={made.sources}
        ladder={ladder}
        market={market}
        wallet={null}
      />,
    );
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(screen.getByText("spread 3¢ · mid 59¢")).toBeInTheDocument();
    return { ...made, market };
  }

  it("push: a new best bid shows as soon as the notification arrives, with no request", async () => {
    const { chain, server, market } = await renderTrade("push");
    const requests = chain.counts.total;
    const book = chain.setBook(market, [[60, 10]], [[61, 40]]);
    act(() => server.push(book, chain.accounts.get(book) as Buffer));
    expect(screen.getByText("spread 1¢ · mid 60¢")).toBeInTheDocument();
    expect(chain.counts.total).toBe(requests);
  });

  it("push: the vault chip's 'as of' keeps ticking while subscriptions are live (no reads)", async () => {
    const { chain } = await renderTrade("push");
    const first = screen.getByTestId("vault-chip").textContent;
    const requests = chain.counts.total;
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByTestId("vault-chip").textContent).not.toBe(first);
    expect(chain.counts.total).toBe(requests);
  });

  it("push: a fill highlights its level for 2 s in both book views (P0-7 unchanged)", async () => {
    const { chain, server, market } = await renderTrade("push");
    const book = chain.setBook(market, [[58, 20]], [[61, 40]]); // 10 filled at 58
    act(() => server.push(book, chain.accounts.get(book) as Buffer));
    const changed = () => screen.getByTestId("book-table").querySelector('tr[data-changed="true"]');
    expect(changed()?.textContent).toContain("58¢");
    fireEvent.click(screen.getByRole("radio", { name: "NO view" }));
    expect(changed()?.textContent).toContain("42¢"); // the same level, 100 − 58
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(changed()).toBeNull();
  });

  it("fallback: a new best bid shows within 1 s", async () => {
    const { chain, market } = await renderTrade("fallback");
    chain.setBook(market, [[60, 10]], [[61, 40]]);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.getByText("spread 1¢ · mid 60¢")).toBeInTheDocument();
  });
});
