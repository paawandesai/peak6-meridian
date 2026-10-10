/**
 * usePythQuotes: React hook for fetching live Pyth price quotes (M3-10, D-055).
 *
 * Polls /api/pyth-quotes every 5 seconds for fresh price data.
 * Returns quotes keyed by ticker for easy lookup.
 */

import { useEffect, useState } from "react";
import { pythQuotesResponseSchema, type PythQuote, type Mag7Ticker } from "./pyth-quotes";
import { isDocumentVisible } from "./visibility";

export type PythQuotesByTicker = Record<string, PythQuote>;

export interface UsePythQuotesResult {
  /** Quotes keyed by ticker. Empty object while loading or on error. */
  readonly quotes: PythQuotesByTicker;
  /** True if currently fetching. */
  readonly loading: boolean;
  /** Last error, if any. */
  readonly error: Error | null;
}

const POLL_INTERVAL_MS = 5_000; // 5 seconds (matches freshness threshold)

/**
 * Fetches Pyth quotes for the given tickers, polling every 5 seconds.
 * If no tickers provided, fetches all MAG7.
 */
export function usePythQuotes(tickers?: readonly Mag7Ticker[]): UsePythQuotesResult {
  const [quotes, setQuotes] = useState<PythQuotesByTicker>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: NodeJS.Timeout | null = null;

    async function fetchQuotes(): Promise<void> {
      try {
        const params = tickers ? `?tickers=${tickers.join(",")}` : "";
        const response = await fetch(`/api/pyth-quotes${params}`);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const parsed = pythQuotesResponseSchema.parse(data);

        if (cancelled) return;

        // Convert array to keyed object
        const byTicker: PythQuotesByTicker = {};
        for (const quote of parsed.quotes) {
          byTicker[quote.ticker] = quote;
        }

        setQuotes(byTicker);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!cancelled) {
          setLoading(false);
          // Schedule next poll
          timeoutId = setTimeout(tick, POLL_INTERVAL_MS);
        }
      }
    }

    // A hidden tab skips the fetch and checks again next interval (P1-2).
    function tick(): void {
      if (isDocumentVisible()) void fetchQuotes();
      else timeoutId = setTimeout(tick, POLL_INTERVAL_MS);
    }

    // Start polling
    void fetchQuotes();

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    };
  }, [tickers?.join(",")]); // Re-fetch if tickers change

  return { quotes, loading, error };
}
