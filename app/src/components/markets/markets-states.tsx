type MarketsEmptyProps = {
  /** Optional message override (defaults to standard "No markets" message). */
  readonly message?: string;
};

/**
 * Empty state for Markets page when no markets exist (P0-3).
 * Default message: "No markets today. Markets are created each trading day." (UI-03 AC6).
 */
export function MarketsEmpty({ message }: MarketsEmptyProps) {
  return (
    <div className="flex flex-col items-center justify-center px-mer-4 py-mer-8 text-center">
      <p className="text-mer-base text-mer-ink-muted">
        {message ?? "No markets today. Markets are created each trading day."}
      </p>
    </div>
  );
}

/**
 * Loading state for Markets page while fetching market data (P0-3).
 * NFR-16: role="status" announces loading state to screen readers.
 */
export function MarketsLoading() {
  return (
    <div role="status" className="flex flex-col items-center justify-center px-mer-4 py-mer-8">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-mer-surface border-t-mer-primary" />
      <p className="mt-mer-3 text-mer-sm text-mer-ink-muted">Loading markets…</p>
    </div>
  );
}

type StalePriceLabelProps = {
  /** Seconds since last price update. */
  readonly staleSecs: number;
};

/**
 * Stale price label shown inline when price is >10s old (P0-3).
 * Displays "price is Xs old" next to the price.
 */
export function StalePriceLabel({ staleSecs }: StalePriceLabelProps) {
  if (staleSecs <= 10) {
    return null;
  }

  return (
    <span className="text-mer-xs text-mer-warning">
      {staleSecs < 60 ? `${staleSecs}s old` : `${Math.floor(staleSecs / 60)}m old`}
    </span>
  );
}

type StalePriceBannerProps = {
  /** Seconds since last price update. */
  readonly staleSecs: number;
};

/**
 * Stale price banner shown at page top when price is >60s old (P0-3).
 * Displays prominent warning that prices may be outdated.
 */
export function StalePriceBanner({ staleSecs }: StalePriceBannerProps) {
  if (staleSecs <= 60) {
    return null;
  }

  return (
    <div className="border-b border-mer-warning bg-mer-warning/10 px-mer-4 py-mer-2">
      <div className="flex items-center gap-mer-2">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-5 w-5 flex-shrink-0 text-mer-warning"
        >
          <path
            fillRule="evenodd"
            d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
            clipRule="evenodd"
          />
        </svg>
        <p className="text-mer-sm text-mer-ink">
          Prices may be outdated — last update was{" "}
          {staleSecs < 120
            ? `${Math.floor(staleSecs / 60)} minute ago`
            : `${Math.floor(staleSecs / 60)} minutes ago`}
        </p>
      </div>
    </div>
  );
}
