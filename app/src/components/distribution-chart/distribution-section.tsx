"use client";

import { useEffect, useState } from "react";

import { DistributionChart } from "./distribution-chart";
import type { DistributionPoint } from "./distribution";

/** Desktop breakpoint (Tailwind `md`): the section starts open at or above it. */
export const DESKTOP_QUERY = "(min-width: 768px)";

export function emptyDistributionText(ticker: string): string {
  return `No market-implied distribution yet: no ${ticker} strike has a two-sided book within 10¢.`;
}

/**
 * The ticker's implied distribution (FR-26) as a disclosure under the Trade book: open on desktop,
 * collapsed on mobile (390 px), and explicit text when no strike has a displayed price. The chart
 * mounts only while open, so a collapsed section costs nothing.
 */
export function DistributionSection({
  ticker,
  points,
}: {
  readonly ticker: string;
  readonly points: readonly DistributionPoint[];
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    if (window.matchMedia(DESKTOP_QUERY).matches) setOpen(true);
  }, []);
  const priced = points.some((point) => point.yesCents !== null);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="grid gap-mer-3 rounded-mer border border-mer-rule p-mer-3"
      data-testid="distribution-section"
    >
      <summary className="min-h-9 cursor-pointer text-mer-md font-semibold">
        Implied distribution: {ticker}{" "}
        <span className="text-mer-xs font-normal text-mer-ink-muted">
          (YES price by strike = chance of closing at or above it)
        </span>
      </summary>
      {open ? (
        priced ? (
          <div className="pt-mer-3">
            <DistributionChart ticker={ticker} points={points} />
          </div>
        ) : (
          <p className="pt-mer-3 text-mer-sm text-mer-ink-muted" data-testid="distribution-empty">
            {emptyDistributionText(ticker)}
          </p>
        )
      ) : null}
    </details>
  );
}
