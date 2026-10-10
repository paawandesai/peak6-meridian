import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type BookQuotes,
  createMarketDataSources,
  INITIAL_MARKET_DATA,
  type MarketData,
  type MarketDataSources,
  pollBooks,
  pollPrices,
  useMarketData,
} from "./market-data";
import { type LivePrice, MAG7 } from "./market-data-shared";
import type { LiveRead, LiveSource } from "./account-feed";
import type { PublicKey } from "@solana/web3.js";
import { market } from "@/test-utils";

const price = (ticker: LivePrice["ticker"], cents: number, stale = false): LivePrice => ({
  ticker,
  price_cents: cents,
  as_of: "2026-10-08T14:30:00.000Z",
  stale,
});
const quotes = (bid: number, ask: number): BookQuotes => ({
  yesBid: bid,
  yesAsk: ask,
  yesMid: Math.floor((bid + ask) / 2),
  noPrice: 100 - Math.floor((bid + ask) / 2),
});

const MARKET_A = market({ address: "11111111111111111111111111111112" });
const MARKET_B = market({ address: "11111111111111111111111111111113", strikeCents: 23_000n });

describe("pollPrices", () => {
  it("maps the route response by ticker", async () => {
    const result = await pollPrices(
      {
        fetchPrices: () =>
          Promise.resolve({
            prices: [price("AAPL", 23_245), price("MSFT", 41_010)],
            unavailable: ["TSLA"],
          }),
      },
      INITIAL_MARKET_DATA,
    );
    expect(result.prices.AAPL?.price_cents).toBe(23_245);
    expect(result.prices.MSFT?.price_cents).toBe(41_010);
    expect(result.pricesUnavailable).toEqual(["TSLA"]);
  });

  it("marks the known prices stale when the route cannot be read, without changing them", async () => {
    const previous: MarketData = {
      ...INITIAL_MARKET_DATA,
      prices: { AAPL: price("AAPL", 23_245) },
    };
    const result = await pollPrices(
      { fetchPrices: () => Promise.reject(new Error("down")) },
      previous,
    );
    expect(result.prices.AAPL).toEqual(price("AAPL", 23_245, true));
    expect(result.pricesUnavailable).not.toContain("AAPL");
    expect(result.pricesUnavailable).toHaveLength(6);
  });

  it("on a first failed poll every ticker is explicitly unavailable", async () => {
    const result = await pollPrices(
      { fetchPrices: () => Promise.reject(new Error("down")) },
      INITIAL_MARKET_DATA,
    );
    expect(result.prices).toEqual({});
    expect([...result.pricesUnavailable]).toEqual([...MAG7]);
  });
});

describe("pollBooks", () => {
  it("returns ready quotes per market and unavailable for a missing book", async () => {
    const books = await pollBooks(
      {
        fetchBooks: () =>
          Promise.resolve({ [MARKET_A.address]: quotes(40, 44), [MARKET_B.address]: null }),
      },
      [MARKET_A, MARKET_B],
    );
    expect(books[MARKET_A.address]).toEqual({ state: "ready", quotes: quotes(40, 44) });
    expect(books[MARKET_B.address]).toEqual({ state: "unavailable" });
  });

  it("keeps a one-sided book ready with null mid/NO (a number is never invented)", async () => {
    const oneSided: BookQuotes = { yesBid: 50, yesAsk: null, yesMid: null, noPrice: null };
    const books = await pollBooks(
      { fetchBooks: () => Promise.resolve({ [MARKET_A.address]: oneSided }) },
      [MARKET_A],
    );
    expect(books[MARKET_A.address]).toEqual({ state: "ready", quotes: oneSided });
  });

  it("marks every market unavailable when the chain read fails, and invalid addresses on their own", async () => {
    const failing = await pollBooks({ fetchBooks: () => Promise.reject(new Error("rpc")) }, [
      MARKET_A,
    ]);
    expect(failing[MARKET_A.address]).toEqual({ state: "unavailable" });
    const fetchBooks = vi.fn().mockResolvedValue({ [MARKET_A.address]: quotes(40, 44) });
    const mixed = await pollBooks({ fetchBooks }, [market({ address: "not-a-key" }), MARKET_A]);
    expect(mixed["not-a-key"]).toEqual({ state: "unavailable" });
    expect(mixed[MARKET_A.address]?.state).toBe("ready");
    expect(fetchBooks).toHaveBeenCalledTimes(1);
  });

  it("does not call the chain for an empty market list", async () => {
    const fetchBooks = vi.fn();
    expect(await pollBooks({ fetchBooks }, [])).toEqual({});
    expect(fetchBooks).not.toHaveBeenCalled();
  });
});

describe("useMarketData", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function sources(overrides: Partial<MarketDataSources> = {}): MarketDataSources {
    return {
      fetchPrices: () => Promise.resolve({ prices: [price("AAPL", 23_245)], unavailable: [] }),
      fetchBooks: () => Promise.resolve({ [MARKET_A.address]: quotes(40, 44) }),
      ...overrides,
    };
  }

  it("starts loading, then exposes live price and YES/NO quotes in integer cents", async () => {
    const { result } = renderHook(() => useMarketData([MARKET_A], sources()));
    expect(result.current.status).toBe("loading");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.prices.AAPL).toEqual(price("AAPL", 23_245));
    expect(result.current.books[MARKET_A.address]).toEqual({
      state: "ready",
      quotes: { yesBid: 40, yesAsk: 44, yesMid: 42, noPrice: 58 },
    });
  });

  it("shows a new order within the 2 s book poll, well inside NFR-01's 3 s", async () => {
    let ask = 44;
    const { result } = renderHook(() =>
      useMarketData(
        [MARKET_A],
        sources({ fetchBooks: () => Promise.resolve({ [MARKET_A.address]: quotes(40, ask) }) }),
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    ask = 42; // a confirmed order lowers the best ask
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000); // P0-4: 2s interval
    });
    const book = result.current.books[MARKET_A.address];
    expect(book?.state === "ready" ? book.quotes.yesAsk : null).toBe(42);
  });

  it("reports unavailable books and stale prices when sources fail", async () => {
    const { result } = renderHook(() =>
      useMarketData(
        [MARKET_A],
        sources({
          fetchPrices: () => Promise.reject(new Error("down")),
          fetchBooks: () => Promise.reject(new Error("rpc")),
        }),
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.prices).toEqual({});
    expect(result.current.pricesUnavailable).toHaveLength(7);
    expect(result.current.books[MARKET_A.address]).toEqual({ state: "unavailable" });
  });

  it("skips a tick while the previous book poll is still in flight (no out-of-order results)", async () => {
    const resolvers: ((value: Record<string, BookQuotes>) => void)[] = [];
    const fetchBooks = vi
      .fn()
      .mockImplementation(
        () => new Promise<Record<string, BookQuotes>>((resolve) => resolvers.push(resolve)),
      );
    const { result } = renderHook(() => useMarketData([MARKET_A], sources({ fetchBooks })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_500);
    });
    expect(fetchBooks).toHaveBeenCalledTimes(1); // three ticks passed, one read in flight
    await act(async () => {
      resolvers[0]?.({ [MARKET_A.address]: quotes(40, 44) });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.books[MARKET_A.address]?.state).toBe("ready");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchBooks).toHaveBeenCalledTimes(2); // polling resumes once the read settled
  });

  it("keeps prices, the unavailable marker and the ready status when only the markets change", async () => {
    const src = sources({
      fetchPrices: () =>
        Promise.resolve({ prices: [price("AAPL", 23_245)], unavailable: ["TSLA"] }),
      fetchBooks: () =>
        Promise.resolve({
          [MARKET_A.address]: quotes(40, 44),
          [MARKET_B.address]: quotes(50, 54),
        }),
    });
    const { result, rerender } = renderHook(({ list }) => useMarketData(list, src), {
      initialProps: { list: [] as ReturnType<typeof market>[] },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("ready");
    rerender({ list: [MARKET_A] }); // the markets list loads after being empty
    expect(result.current.prices.AAPL?.price_cents).toBe(23_245);
    expect(result.current.pricesUnavailable).toEqual(["TSLA"]);
    expect(result.current.status).toBe("ready");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.books[MARKET_A.address]?.state).toBe("ready");
    rerender({ list: [MARKET_B] }); // A is no longer listed: its book is dropped, prices stay
    expect(result.current.books[MARKET_A.address]).toBeUndefined();
    expect(result.current.prices.AAPL?.price_cents).toBe(23_245);
    expect(result.current.status).toBe("ready");
  });

  it("stops polling on unmount", async () => {
    const fetchBooks = vi.fn().mockResolvedValue({ [MARKET_A.address]: quotes(40, 44) });
    const { unmount } = renderHook(() => useMarketData([MARKET_A], sources({ fetchBooks })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const calls = fetchBooks.mock.calls.length;
    unmount();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchBooks.mock.calls.length).toBe(calls);
  });

  it("does not restart polling when given a new array with the same markets", async () => {
    const fetchBooks = vi.fn().mockResolvedValue({ [MARKET_A.address]: quotes(40, 44) });
    const src = sources({ fetchBooks });
    const { rerender } = renderHook(({ list }) => useMarketData(list, src), {
      initialProps: { list: [MARKET_A] },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const calls = fetchBooks.mock.calls.length;
    rerender({ list: [{ ...MARKET_A }] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchBooks.mock.calls.length).toBe(calls);
  });
});

describe("useMarketData with pushed books (P1-2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_900_000_000_000); // before MARKET_A/B close (2_000_000_000), after CLOSED's
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const CLOSED = market({ address: "11111111111111111111111111111114", closeTs: 1_800_000_000n });

  function liveBooksFake() {
    let current: LiveRead<Record<string, BookQuotes | null>> = { status: "loading" };
    const listeners = new Set<() => void>();
    const calls: { markets: string[]; fastMs: number }[] = [];
    const liveBooks = (markets: readonly PublicKey[], fastMs: number) => {
      calls.push({ markets: markets.map((m) => m.toBase58()), fastMs });
      const source: LiveSource<Record<string, BookQuotes | null>> = {
        subscribe: (onChange) => {
          listeners.add(onChange);
          return () => listeners.delete(onChange);
        },
        read: () => current,
        isLive: () => true,
        refresh: () => undefined,
      };
      return source;
    };
    const push = (next: LiveRead<Record<string, BookQuotes | null>>) => {
      current = next;
      for (const listener of [...listeners]) listener();
    };
    return { liveBooks, push, calls, listeners };
  }

  const prices = () => Promise.resolve({ prices: [price("AAPL", 23_245)], unavailable: [] });

  it("pushes open markets' books and reads closed ones once by polling", async () => {
    const live = liveBooksFake();
    const fetchBooks = vi.fn().mockResolvedValue({ [CLOSED.address]: quotes(10, 12) });
    const { result } = renderHook(() =>
      useMarketData([MARKET_A, MARKET_B, CLOSED], {
        fetchPrices: prices,
        fetchBooks,
        liveBooks: live.liveBooks,
      }),
    );
    expect(live.calls).toEqual([{ markets: [MARKET_A.address, MARKET_B.address], fastMs: 2_000 }]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("loading"); // pushed books not read yet
    act(() =>
      live.push({
        status: "ready",
        value: { [MARKET_A.address]: quotes(40, 44), [MARKET_B.address]: null },
      }),
    );
    expect(result.current.status).toBe("ready");
    expect(result.current.books[MARKET_A.address]).toEqual({
      state: "ready",
      quotes: quotes(40, 44),
    });
    expect(result.current.books[MARKET_B.address]).toEqual({ state: "unavailable" });
    expect(result.current.books[CLOSED.address]).toEqual({
      state: "ready",
      quotes: quotes(10, 12),
    });
    // A pushed change shows at once; the closed book is never polled again.
    act(() =>
      live.push({
        status: "ready",
        value: { [MARKET_A.address]: quotes(41, 43), [MARKET_B.address]: quotes(50, 54) },
      }),
    );
    expect(result.current.books[MARKET_A.address]).toEqual({
      state: "ready",
      quotes: quotes(41, 43),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchBooks).toHaveBeenCalledTimes(1);
    expect(fetchBooks.mock.calls[0]?.[0].map((k: PublicKey) => k.toBase58())).toEqual([
      CLOSED.address,
    ]);
  });

  it("marks pushed markets unavailable on a read error, keeping earlier quotes", async () => {
    const live = liveBooksFake();
    const { result } = renderHook(() =>
      useMarketData([MARKET_A], {
        fetchPrices: prices,
        fetchBooks: vi.fn(),
        liveBooks: live.liveBooks,
      }),
    );
    act(() => live.push({ status: "error", message: "rpc down" }));
    expect(result.current.books[MARKET_A.address]).toEqual({ state: "unavailable" });
    act(() => live.push({ status: "ready", value: { [MARKET_A.address]: quotes(40, 44) } }));
    act(() => live.push({ status: "error", message: "429" }));
    expect(result.current.books[MARKET_A.address]).toEqual({
      state: "ready",
      quotes: quotes(40, 44),
    });
  });

  it("stops listening on unmount and does not poll books it pushes", async () => {
    const live = liveBooksFake();
    const fetchBooks = vi.fn();
    const { unmount } = renderHook(() =>
      useMarketData([MARKET_A], { fetchPrices: prices, fetchBooks, liveBooks: live.liveBooks }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchBooks).not.toHaveBeenCalled();
    expect(live.listeners.size).toBe(1);
    unmount();
    expect(live.listeners.size).toBe(0);
  });

  it("polls an unparsable address instead of subscribing it", async () => {
    const live = liveBooksFake();
    const bad = market({ address: "not-a-key" });
    const { result } = renderHook(() =>
      useMarketData([bad], { fetchPrices: prices, fetchBooks: vi.fn(), liveBooks: live.liveBooks }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(live.calls).toEqual([]);
    expect(result.current.books["not-a-key"]).toEqual({ state: "unavailable" });
  });
});

describe("createMarketDataSources (browser sources)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const body = { prices: [price("AAPL", 23_245)], unavailable: [] };

  it("reads and validates /api/market-data", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await createMarketDataSources().fetchPrices()).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/market-data", { cache: "no-store" });
  });

  it("offers pushed books (P1-2) next to the polled ones", () => {
    const sources = createMarketDataSources();
    expect(sources.liveBooks).toBeTypeOf("function");
    expect(sources.fetchBooks).toBeTypeOf("function");
  });

  it("rejects a non-ok status and a malformed body", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("x", { status: 500 })));
    await expect(createMarketDataSources().fetchPrices()).rejects.toThrow("500");
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(JSON.stringify({ prices: [{ ticker: "AAPL" }], unavailable: [] })),
      ),
    );
    await expect(createMarketDataSources().fetchPrices()).rejects.toThrow();
  });
});
