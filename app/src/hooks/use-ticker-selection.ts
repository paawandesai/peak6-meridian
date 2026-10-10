import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const TICKERS = ["AAPL", "AMZN", "GOOGL", "META", "MSFT", "NVDA", "TSLA", "All"] as const;
type TickerOrAll = (typeof TICKERS)[number];

const STORAGE_KEY = "meridian-last-ticker";

type UseTickerSelectionOptions = {
  /** Default ticker when no ?t= param and no localStorage (defaults to "All"). */
  readonly defaultTicker?: TickerOrAll;
};

/**
 * Hook for ticker selection state with URL sync (?t=) and localStorage persistence (P0-3).
 * - Reads ?t= query param on mount
 * - Syncs selection to URL on change (with back/forward support)
 * - Persists last selected ticker to localStorage
 * - Returns current ticker and setter
 */
export function useTickerSelection(
  options: UseTickerSelectionOptions = {}
): [TickerOrAll, (ticker: TickerOrAll) => void] {
  const { defaultTicker = "All" } = options;
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [ticker, setTickerState] = useState<TickerOrAll>(defaultTicker);

  // Initialize from URL param or localStorage
  useEffect(() => {
    const paramTicker = searchParams.get("t");
    if (paramTicker && TICKERS.includes(paramTicker as TickerOrAll)) {
      setTickerState(paramTicker as TickerOrAll);
      return;
    }

    // Fallback to localStorage
    const storedTicker = localStorage.getItem(STORAGE_KEY);
    if (storedTicker && TICKERS.includes(storedTicker as TickerOrAll)) {
      setTickerState(storedTicker as TickerOrAll);
      // Update URL to match localStorage
      const params = new URLSearchParams(searchParams.toString());
      params.set("t", storedTicker);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    }
  }, []); // Run once on mount

  const setTicker = (newTicker: TickerOrAll) => {
    setTickerState(newTicker);

    // Update URL
    const params = new URLSearchParams(searchParams.toString());
    params.set("t", newTicker);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });

    // Persist to localStorage
    localStorage.setItem(STORAGE_KEY, newTicker);
  };

  return [ticker, setTicker];
}
