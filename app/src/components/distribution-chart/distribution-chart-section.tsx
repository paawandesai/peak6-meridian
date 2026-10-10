/**
 * Distribution chart section wrapper (P0-7): collapsible on mobile, open on desktop.
 * Mounts the DistributionChart with responsive collapse behavior for the Trade page.
 */

"use client";

import { useState } from "react";
import { DistributionChart } from "./distribution-chart";
import type { DistributionPoint } from "./distribution";

export type DistributionChartSectionProps = {
  readonly ticker: string;
  readonly points: readonly DistributionPoint[];
  /** Default collapsed state. Defaults to collapsed on mobile (< 768px), open on desktop. */
  readonly defaultCollapsed?: boolean;
};

/**
 * Wraps DistributionChart with collapse/expand for Trade page.
 * Collapsed on mobile by default, open on desktop (design.md §5 Trade).
 */
export function DistributionChartSection({
  ticker,
  points,
  defaultCollapsed,
}: DistributionChartSectionProps) {
  // Default: collapsed on mobile (assumed < 768px), open otherwise
  const [collapsed, setCollapsed] = useState(
    defaultCollapsed ?? (typeof window !== "undefined" && window.innerWidth < 768),
  );

  if (points.length === 0) {
    return (
      <section className="rounded-mer border border-mer-rule p-mer-4" data-testid="distribution-section">
        <p className="text-mer-sm text-mer-ink-muted">
          Distribution chart: no data available for {ticker}.
        </p>
      </section>
    );
  }

  return (
    <section
      className="rounded-mer border border-mer-rule p-mer-4"
      data-testid="distribution-section"
    >
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="mb-mer-3 flex w-full items-center justify-between text-left hover:underline md:cursor-default md:hover:no-underline"
        aria-expanded={!collapsed}
        data-testid="distribution-toggle"
      >
        <span className="text-mer-lg font-semibold">
          Implied distribution: {ticker}
        </span>
        <span className="md:hidden" aria-hidden="true">
          {collapsed ? "▸" : "▾"}
        </span>
      </button>
      {!collapsed && <DistributionChart ticker={ticker} points={points} />}
    </section>
  );
}
