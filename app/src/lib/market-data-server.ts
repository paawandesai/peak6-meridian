/**
 * Server-side live stock prices for the seven tickers (M2-05). Only the route handler imports
 * this module; it must never be imported from a client component, because it is the one place
 * that touches the upstream API keys. Keys are sent in request headers (never in a URL), and
 * failures are logged by provider, ticker and status only, so no key or full URL reaches a log.
 */
import { z } from "zod";

import {
  dollarsToCents,
  type LivePrice,
  MAG7,
  type Mag7Ticker,
  type MarketDataResponse,
} from "./market-data-shared";

/** Upper bound for the server cache (the ticket's "cached ≤ 5 s"). */
export const MAX_CACHE_MS = 5_000;
const REQUEST_TIMEOUT_MS = 3_000;

export type Quote = { readonly price_cents: number; readonly as_of: string };
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export type LogFn = (entry: Record<string, string | number>) => void;

/** One upstream. Resolves to a quote or throws; the service decides what to do with failures. */
export type Provider = {
  readonly name: string;
  quote(ticker: Mag7Ticker, fetcher: Fetcher): Promise<Quote>;
};

class UpstreamError extends Error {
  override readonly name = "UpstreamError";
}

const finnhubSchema = z.object({ c: z.number(), t: z.number() });

export function finnhubProvider(apiKey: string): Provider {
  return {
    name: "finnhub",
    async quote(ticker, fetcher) {
      const response = await fetcher(
        `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}`,
        { headers: { "X-Finnhub-Token": apiKey }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      );
      if (!response.ok) throw new UpstreamError(`status ${response.status}`);
      const body = finnhubSchema.parse(await response.json());
      const cents = dollarsToCents(body.c);
      // Finnhub reports `t: 0` and `c: 0` for an unknown symbol or no data.
      if (cents === null || body.t <= 0) throw new UpstreamError("no price");
      return { price_cents: cents, as_of: new Date(body.t * 1000).toISOString() };
    },
  };
}

const tiingoSchema = z.array(
  z.object({
    ticker: z.string(),
    last: z.number().nullable().optional(),
    tngoLast: z.number().nullable().optional(),
    timestamp: z.string(),
  }),
);

export function tiingoProvider(apiKey: string): Provider {
  return {
    name: "tiingo",
    async quote(ticker, fetcher) {
      const response = await fetcher(
        `https://api.tiingo.com/iex/?tickers=${encodeURIComponent(ticker.toLowerCase())}`,
        {
          headers: { Authorization: `Token ${apiKey}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) throw new UpstreamError(`status ${response.status}`);
      const rows = tiingoSchema.parse(await response.json());
      const row = rows.find((candidate) => candidate.ticker.toUpperCase() === ticker);
      const cents = dollarsToCents(row?.tngoLast ?? row?.last);
      const asOf = row === undefined ? Number.NaN : Date.parse(row.timestamp);
      if (cents === null || Number.isNaN(asOf)) throw new UpstreamError("no price");
      return { price_cents: cents, as_of: new Date(asOf).toISOString() };
    },
  };
}

/** Providers in preference order, from the server environment (a key that is unset is skipped). */
export function providersFromEnv(env: {
  readonly FINNHUB_API_KEY?: string | undefined;
  readonly TIINGO_API_KEY?: string | undefined;
}): Provider[] {
  const providers: Provider[] = [];
  if (env.FINNHUB_API_KEY !== undefined && env.FINNHUB_API_KEY !== "") {
    providers.push(finnhubProvider(env.FINNHUB_API_KEY));
  }
  if (env.TIINGO_API_KEY !== undefined && env.TIINGO_API_KEY !== "") {
    providers.push(tiingoProvider(env.TIINGO_API_KEY));
  }
  return providers;
}

export type MarketDataService = {
  get(tickers: readonly Mag7Ticker[]): Promise<MarketDataResponse>;
};

type Cached = { readonly quote: Quote; readonly fetchedAt: number };

/**
 * Per-ticker cache of at most `cacheMs` (≤ 5 s), with the same window as a negative cache after a failed refresh (so an outage costs one provider round per ticker per window, not one per request). On an upstream failure the last known price is
 * returned with `stale: true`; with nothing cached the ticker is reported as unavailable. A
 * price is never invented, rounded from an old one, or carried over to another ticker.
 */
export function createMarketDataService(options: {
  readonly providers: readonly Provider[];
  readonly fetcher: Fetcher;
  readonly now: () => number;
  readonly log: LogFn;
  readonly cacheMs?: number;
}): MarketDataService {
  const cacheMs = Math.min(options.cacheMs ?? MAX_CACHE_MS, MAX_CACHE_MS);
  if (options.providers.length === 0) {
    // Fail loudly: a deploy with neither API key set would otherwise answer "unavailable" forever.
    options.log({
      event: "market_data_no_providers",
      detail: "set FINNHUB_API_KEY and/or TIINGO_API_KEY on the server",
    });
  }
  const cache = new Map<Mag7Ticker, Cached>();
  /** When the last refresh of a ticker failed, so an outage is not retried inside `cacheMs`. */
  const failedAt = new Map<Mag7Ticker, number>();
  const inflight = new Map<Mag7Ticker, Promise<Quote | null>>();

  async function refresh(ticker: Mag7Ticker): Promise<Quote | null> {
    for (const provider of options.providers) {
      try {
        const quote = await provider.quote(ticker, options.fetcher);
        cache.set(ticker, { quote, fetchedAt: options.now() });
        failedAt.delete(ticker);
        return quote;
      } catch (error) {
        // Only the provider, ticker and a short reason: error messages can echo a URL.
        options.log({
          event: "market_data_upstream_failed",
          provider: provider.name,
          ticker,
          reason: error instanceof UpstreamError ? error.message : (error as Error).name,
        });
      }
    }
    failedAt.set(ticker, options.now());
    return null;
  }

  function fresh(ticker: Mag7Ticker): Promise<Quote | null> {
    const pending = inflight.get(ticker);
    if (pending !== undefined) return pending;
    const started = refresh(ticker).finally(() => inflight.delete(ticker));
    inflight.set(ticker, started);
    return started;
  }

  return {
    async get(tickers) {
      const unique = [...new Set(tickers)];
      const results = await Promise.all(
        unique.map(async (ticker): Promise<LivePrice | Mag7Ticker> => {
          const cached = cache.get(ticker);
          if (cached !== undefined && options.now() - cached.fetchedAt < cacheMs) {
            return { ticker, ...cached.quote, stale: false };
          }
          const failed = failedAt.get(ticker);
          // After a failed refresh, do not hit the providers again inside the cache window.
          const quote =
            failed !== undefined && options.now() - failed < cacheMs ? null : await fresh(ticker);
          if (quote !== null) return { ticker, ...quote, stale: false };
          return cached === undefined ? ticker : { ticker, ...cached.quote, stale: true };
        }),
      );
      return {
        prices: results.filter((entry): entry is LivePrice => typeof entry !== "string"),
        unavailable: results.filter((entry): entry is Mag7Ticker => typeof entry === "string"),
      };
    },
  };
}

/** All tickers, for a request with no `tickers` filter. */
export const ALL_TICKERS: readonly Mag7Ticker[] = MAG7;
