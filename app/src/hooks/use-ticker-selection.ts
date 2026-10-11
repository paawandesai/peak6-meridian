import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const TICKERS = ["AAPL", "AMZN", "GOOGL", "META", "MSFT", "NVDA", "TSLA", "All"] as const;
type TickerOrAll = (typeof TICKERS)[number];

const STORAGE_KEY = "meridian-last-ticker";

type UseTickerSelectionOptions = {
  /** Default ticker when no ?t= param and no localStorage (defaults to "All"). */
  readonly defaultTicker?: TickerOrAll;
};

function parseTicker(value: string | null): TickerOrAll | null {
  return value !== null && (TICKERS as readonly string[]).includes(value)
    ? (value as TickerOrAll)
    : null;
}

/**
 * Hook for ticker selection state with URL sync (?t=) and localStorage persistence (P0-3).
 * - The ?t= query param is the source of truth and is read on every render, so a selection made
 *   anywhere (the tab bar rewrites ?t= itself) shows at once, without a reload
 * - Without ?t=, restores the last ticker from localStorage after mount and writes it to the URL
 * - Persists every selection, from the URL or the setter, to localStorage
 * - Returns current ticker and setter
 */
export function useTickerSelection(
  options: UseTickerSelectionOptions = {},
): [TickerOrAll, (ticker: TickerOrAll) => void] {
  const { defaultTicker = "All" } = options;
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const fromUrl = parseTicker(searchParams.get("t"));
  // Used only while the URL carries no valid ?t= (first paint, or before the restore lands).
  const [fallback, setFallback] = useState<TickerOrAll>(defaultTicker);

  // Without ?t=, restore the last ticker from localStorage (after mount: no hydration mismatch).
  useEffect(() => {
    if (fromUrl !== null) {
      return;
    }
    const storedTicker = parseTicker(localStorage.getItem(STORAGE_KEY));
    if (storedTicker !== null) {
      setFallback(storedTicker);
      // Update URL to match localStorage
      const params = new URLSearchParams(searchParams.toString());
      params.set("t", storedTicker);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    }
  }, []); // Run once on mount

  // Remember a selection made through the URL (the tab bar) as well as through the setter.
  useEffect(() => {
    if (fromUrl !== null) {
      localStorage.setItem(STORAGE_KEY, fromUrl);
    }
  }, [fromUrl]);

  const setTicker = (newTicker: TickerOrAll) => {
    setFallback(newTicker);

    // Update URL
    const params = new URLSearchParams(searchParams.toString());
    params.set("t", newTicker);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });

    // Persist to localStorage
    localStorage.setItem(STORAGE_KEY, newTicker);
  };

  return [fromUrl ?? fallback, setTicker];
}
