/**
 * Live market data for the Markets page (M2-05, data only). `useMarketData` exposes the live
 * stock price per ticker and, per market, the book-derived YES best bid / best ask / mid and the
 * NO price in integer cents, with an explicit `unavailable` state whenever a value cannot be
 * read. It never fabricates a number. Presentation is UI-03's: this module has no JSX.
 */
import type { BookQuotes } from "@meridian/client";
import { PublicKey } from "@solana/web3.js";
import { useEffect, useRef, useState } from "react";

import { type BookSource, createBookSource } from "./book";
import { loadPublicConfig } from "./config";
import type { MarketRow } from "./markets";
import {
  type LivePrice,
  type Mag7Ticker,
  type MarketDataResponse,
  MAG7,
  marketDataResponseSchema,
} from "./market-data-shared";

export type { BookQuotes, LivePrice };

/** Per-market book state: quotes (each side may be `null` for an empty side) or unavailable. */
export type MarketBook =
  { readonly state: "ready"; readonly quotes: BookQuotes } | { readonly state: "unavailable" };

export type MarketData = {
  /** `loading` until the first poll of both sources settles. */
  readonly status: "loading" | "ready";
  /** Live stock price per ticker (`stale: true` is the last known price after an upstream failure). */
  readonly prices: Readonly<Partial<Record<Mag7Ticker, LivePrice>>>;
  /** Tickers whose price is unavailable (no cached price at all). */
  readonly pricesUnavailable: readonly Mag7Ticker[];
  /** Book quotes per market address. */
  readonly books: Readonly<Record<string, MarketBook>>;
};

export const INITIAL_MARKET_DATA: MarketData = {
  status: "loading",
  prices: {},
  pricesUnavailable: [],
  books: {},
};

export type MarketDataSources = {
  fetchPrices(): Promise<MarketDataResponse>;
  fetchBooks: BookSource;
};

/** Browser sources: the server route for prices, the chain for books. */
export function createMarketDataSources(): MarketDataSources {
  const fetchBooks = createBookSource(loadPublicConfig());
  return {
    fetchPrices: async () => {
      const response = await fetch("/api/market-data", { cache: "no-store" });
      if (!response.ok) throw new Error(`market-data route returned ${response.status}`);
      return marketDataResponseSchema.parse(await response.json());
    },
    fetchBooks,
  };
}

/** One price poll folded into `previous`; a failed poll marks the known prices stale. */
export async function pollPrices(
  sources: Pick<MarketDataSources, "fetchPrices">,
  previous: MarketData,
): Promise<Pick<MarketData, "prices" | "pricesUnavailable">> {
  try {
    const response = await sources.fetchPrices();
    const prices: Partial<Record<Mag7Ticker, LivePrice>> = {};
    for (const price of response.prices) prices[price.ticker] = price;
    return { prices, pricesUnavailable: response.unavailable };
  } catch {
    const prices: Partial<Record<Mag7Ticker, LivePrice>> = {};
    for (const price of Object.values(previous.prices)) {
      prices[price.ticker] = { ...price, stale: true };
    }
    // Every ticker with no known price is explicitly unavailable (all seven on a first failure),
    // so a consumer can tell "price unavailable" from "not requested".
    return { prices, pricesUnavailable: MAG7.filter((ticker) => prices[ticker] === undefined) };
  }
}

/**
 * One book poll for `markets`; a market that cannot be read is `unavailable`, not guessed.
 * P0-4: fetchBooks chunks the RPC calls internally (≤99 keys each) to stay under the 100-key limit.
 */
export async function pollBooks(
  sources: Pick<MarketDataSources, "fetchBooks">,
  markets: readonly MarketRow[],
): Promise<Record<string, MarketBook>> {
  const books: Record<string, MarketBook> = {};
  const readable: { row: MarketRow; key: PublicKey }[] = [];
  for (const row of markets) {
    try {
      readable.push({ row, key: new PublicKey(row.address) });
    } catch {
      books[row.address] = { state: "unavailable" };
    }
  }
  if (readable.length === 0) return books;
  try {
    const quotes = await sources.fetchBooks(readable.map(({ key }) => key));
    for (const { row } of readable) {
      const found = quotes[row.address];
      books[row.address] =
        found === undefined || found === null
          ? { state: "unavailable" }
          : { state: "ready", quotes: found };
    }
  } catch {
    for (const { row } of readable) books[row.address] = { state: "unavailable" };
  }
  return books;
}

export type MarketDataOptions = {
  /** Price poll interval; the server caches for at most 5 s, so faster is pointless. */
  readonly priceIntervalMs?: number;
  /** Book poll interval; 1 s keeps a confirmed order visible well within NFR-01's 3 s. */
  readonly bookIntervalMs?: number;
  /** Whether to pause polling (for tests); defaults to checking document.visibilityState. */
  readonly shouldPoll?: () => boolean;
};

/** Polls prices and books; `sources` defaults to the browser sources and is injectable for tests. */
export function useMarketData(
  markets: readonly MarketRow[],
  sources?: MarketDataSources,
  options: MarketDataOptions = {},
): MarketData {
  const [data, setData] = useState<MarketData>(INITIAL_MARKET_DATA);
  const priceIntervalMs = options.priceIntervalMs ?? 5_000;
  const bookIntervalMs = options.bookIntervalMs ?? 1_000;
  const shouldPoll =
    options.shouldPoll ??
    (() => typeof document === "undefined" || document.visibilityState === "visible");
  const marketKey = markets.map((market) => market.address).join(",");
  // Keyed by address list so a new array with the same markets does not restart polling.
  const marketsRef = useRef(markets);
  marketsRef.current = markets;
  // The latest sources are read through a ref so a new object each render cannot restart polling.
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  // Survives effect restarts (a markets-only change), so prices on screen and the explicit
  // `pricesUnavailable` marker are never reset to empty and `status` never goes back to loading.
  const stateRef = useRef({ data: INITIAL_MARKET_DATA, pricesDone: false, booksDone: false });

  useEffect(() => {
    let cancelled = false;
    const active = sourcesRef.current ?? createMarketDataSources();
    const state = stateRef.current;
    // Keep the books of markets that are still listed; entries for new markets appear once their
    // first read settles.
    const listed = new Set(marketsRef.current.map((market) => market.address));
    let latest: MarketData = {
      ...state.data,
      books: Object.fromEntries(
        Object.entries(state.data.books).filter(([address]) => listed.has(address)),
      ),
    };
    if (Object.keys(latest.books).length !== Object.keys(state.data.books).length) {
      state.data = latest;
      setData(latest);
    }
    const publish = (next: MarketData): void => {
      latest = {
        ...next,
        status: state.pricesDone && state.booksDone ? "ready" : "loading",
      };
      state.data = latest;
      if (!cancelled) setData(latest);
    };
    // A tick is skipped while the previous poll of the same kind is still in flight, so responses
    // can never be applied out of order (an older read overwriting a newer one). Also skip ticks
    // when the document is hidden (P0-4 visibility pause).
    let pricesInFlight = false;
    let booksInFlight = false;
    const runPrices = async (): Promise<void> => {
      if (!shouldPoll() || pricesInFlight) return;
      pricesInFlight = true;
      try {
        const result = await pollPrices(active, latest);
        state.pricesDone = true;
        publish({ ...latest, ...result });
      } finally {
        pricesInFlight = false;
      }
    };
    const runBooks = async (): Promise<void> => {
      if (!shouldPoll() || booksInFlight) return;
      booksInFlight = true;
      try {
        const books = await pollBooks(active, marketsRef.current);
        state.booksDone = true;
        publish({ ...latest, books });
      } finally {
        booksInFlight = false;
      }
    };
    void runPrices();
    void runBooks();
    const priceTimer = setInterval(() => void runPrices(), priceIntervalMs);
    const bookTimer = setInterval(() => void runBooks(), bookIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(priceTimer);
      clearInterval(bookTimer);
    };
  }, [marketKey, priceIntervalMs, bookIntervalMs]);

  return data;
}
