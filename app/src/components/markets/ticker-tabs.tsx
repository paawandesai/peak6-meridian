"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useEffect, useState, useRef, type KeyboardEvent } from "react";
import type { TickerGroup } from "@/lib/markets";

const TICKERS = ["AAPL", "AMZN", "GOOGL", "META", "MSFT", "NVDA", "TSLA"] as const;
type Ticker = (typeof TICKERS)[number];
type TickerOrAll = Ticker | "All";

type TickerInfo = {
  readonly ticker: TickerOrAll;
  /** Live Pyth price in dollars, null if unavailable. */
  readonly price: number | null;
  /** Price timestamp in seconds (Unix), null if unavailable. */
  readonly priceAsOf: number | null;
  /** Number of open markets for this ticker. */
  readonly activeCount: number;
};

type Props = {
  readonly tickerGroups: readonly TickerGroup[];
};

/**
 * Sticky ticker tab bar (P0-3 FR-16, US-02).
 * - 7 tickers (AAPL · AMZN · GOOGL · META · MSFT · NVDA · TSLA) plus "All"
 * - Each displays: live Pyth price, "as of" time on hover, active contract count
 * - Selection persisted in ?t= query param
 * - Mobile defaults to first ticker with open markets (or first ticker)
 * - Desktop defaults to "All"
 * - Keyboard: arrow keys move between tabs, 2px focus ring
 */
export function TickerTabs({ tickerGroups }: Props) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [isMobile, setIsMobile] = useState(false);
  const tabsRef = useRef<(HTMLButtonElement | null)[]>([]);

  // Detect mobile viewport (< 768px per Tailwind md breakpoint)
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // Calculate ticker info (price, count)
  const tickerInfo: TickerInfo[] = TICKERS.map((ticker) => {
    const group = tickerGroups.find((g) => g.ticker === ticker);
    const activeCount = group?.markets.filter((m) => !m.settled).length ?? 0;

    // TODO (M3): Fetch live Pyth price (will be added in follow-up ticker with price feed)
    const price = null;
    const priceAsOf = null;

    return { ticker, price, priceAsOf, activeCount };
  });

  // Add "All" tab
  const allCount = tickerGroups.reduce(
    (sum, g) => sum + g.markets.filter((m) => !m.settled).length,
    0,
  );
  const allInfo: TickerInfo = { ticker: "All", price: null, priceAsOf: null, activeCount: allCount };
  const allTickerInfo = [...tickerInfo, allInfo];

  // Determine selected ticker
  const selectedParam = searchParams.get("t");
  const defaultTicker: TickerOrAll = isMobile
    ? tickerInfo.find((t) => t.activeCount > 0)?.ticker ?? TICKERS[0]
    : "All";
  const selected: TickerOrAll =
    selectedParam && [...TICKERS, "All"].includes(selectedParam as TickerOrAll)
      ? (selectedParam as TickerOrAll)
      : defaultTicker;

  const handleSelect = (ticker: TickerOrAll) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("t", ticker);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let newIndex = index;

    if (event.key === "ArrowRight") {
      event.preventDefault();
      newIndex = (index + 1) % allTickerInfo.length;
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      newIndex = (index - 1 + allTickerInfo.length) % allTickerInfo.length;
    } else if (event.key === "Home") {
      event.preventDefault();
      newIndex = 0;
    } else if (event.key === "End") {
      event.preventDefault();
      newIndex = allTickerInfo.length - 1;
    } else {
      return; // No arrow key, don't change focus
    }

    const newTab = tabsRef.current[newIndex];
    const newInfo = allTickerInfo[newIndex];
    if (newTab && newInfo) {
      newTab.focus();
      handleSelect(newInfo.ticker);
    }
  };

  return (
    <div className="sticky top-0 z-10 border-b border-mer-rule bg-mer-paper">
      <div
        role="tablist"
        aria-label="Stock ticker selector"
        className="flex gap-mer-2 overflow-x-auto px-mer-4 py-mer-3"
      >
        {allTickerInfo.map((info, index) => {
          const isSelected = info.ticker === selected;
          return (
            <button
              key={info.ticker}
              ref={(el) => {
                tabsRef.current[index] = el;
              }}
              role="tab"
              aria-selected={isSelected}
              aria-controls={`ticker-panel-${info.ticker}`}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => handleSelect(info.ticker)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              className={`
                flex-shrink-0 rounded-mer-lg px-mer-3 py-mer-2 text-mer-sm transition-colors
                focus:outline-none focus:ring-2 focus:ring-mer-primary focus:ring-offset-2
                ${
                  isSelected
                    ? "bg-mer-primary text-mer-on-primary"
                    : "bg-mer-surface text-mer-ink hover:bg-mer-surface-hover"
                }
              `}
              title={
                info.priceAsOf
                  ? `Price as of ${new Date(info.priceAsOf * 1000).toLocaleTimeString("en-US", {
                      timeZone: "America/New_York",
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZoneName: "short",
                    })}`
                  : undefined
              }
            >
              <div className="flex flex-col items-start gap-mer-0.5">
                <span className="font-mer-medium">{info.ticker}</span>
                {info.price !== null && (
                  <span className="text-mer-xs opacity-90">
                    ${info.price.toFixed(2)}
                  </span>
                )}
                {info.activeCount > 0 && (
                  <span className="text-mer-xs opacity-75">
                    {info.activeCount} {info.activeCount === 1 ? "market" : "markets"}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
