/**
 * Tests for Pyth price display components (M3-10, D-055).
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PythPrice, PythPricePlaceholder } from "./pyth-price";
import { PYTH_FEED_IDS } from "@/lib/pyth-quotes";

describe("PythPrice", () => {
  it("displays price in dollars with confidence", () => {
    const quote = {
      ticker: "AAPL" as const,
      price_cents: 22500, // $225.00
      conf_cents: 50, // ±$0.50
      publish_time: 1700000000,
      feed_id: PYTH_FEED_IDS.AAPL,
    };
    const nowMs = 1700000000 * 1000 + 2000; // 2 seconds later

    render(<PythPrice quote={quote} nowMs={nowMs} />);

    // Check price is displayed
    expect(screen.getByText(/\$225\.00/)).toBeInTheDocument();
    // Check confidence is displayed
    expect(screen.getByText(/±\$0\.50/)).toBeInTheDocument();
    // Check age is displayed
    expect(screen.getByText(/2s ago/)).toBeInTheDocument();
    // Check Pyth badge is present
    expect(screen.getByText("Pyth")).toBeInTheDocument();
  });

  it("displays price without confidence when conf is zero", () => {
    const quote = {
      ticker: "MSFT" as const,
      price_cents: 42000,
      conf_cents: 0,
      publish_time: 1700000000,
      feed_id: PYTH_FEED_IDS.MSFT,
    };
    const nowMs = 1700000000 * 1000 + 1000;

    render(<PythPrice quote={quote} nowMs={nowMs} />);

    expect(screen.getByText(/\$420\.00/)).toBeInTheDocument();
    expect(screen.queryByText(/±/)).not.toBeInTheDocument();
  });

  it("shows stale indicator when quote is >= 5s old", () => {
    const quote = {
      ticker: "AAPL" as const,
      price_cents: 22500,
      conf_cents: 50,
      publish_time: 1700000000,
      feed_id: PYTH_FEED_IDS.AAPL,
    };
    const nowMs = 1700000000 * 1000 + 5000; // exactly 5 seconds later

    render(<PythPrice quote={quote} nowMs={nowMs} />);

    expect(screen.getByText(/stale/)).toBeInTheDocument();
    expect(screen.getByText(/5s ago/)).toBeInTheDocument();
  });

  it("does not show stale indicator for fresh quotes", () => {
    const quote = {
      ticker: "AAPL" as const,
      price_cents: 22500,
      conf_cents: 50,
      publish_time: 1700000000,
      feed_id: PYTH_FEED_IDS.AAPL,
    };
    const nowMs = 1700000000 * 1000 + 4000; // 4 seconds later

    render(<PythPrice quote={quote} nowMs={nowMs} />);

    expect(screen.queryByText(/stale/)).not.toBeInTheDocument();
  });

  it("formats ages over 60 seconds as minutes", () => {
    const quote = {
      ticker: "AAPL" as const,
      price_cents: 22500,
      conf_cents: 50,
      publish_time: 1700000000,
      feed_id: PYTH_FEED_IDS.AAPL,
    };
    const nowMs = 1700000000 * 1000 + 120000; // 2 minutes later

    render(<PythPrice quote={quote} nowMs={nowMs} />);

    expect(screen.getByText(/2m ago/)).toBeInTheDocument();
  });
});

describe("PythPricePlaceholder", () => {
  it("displays loading message", () => {
    render(<PythPricePlaceholder />);
    expect(screen.getByText(/Pyth price loading/)).toBeInTheDocument();
  });
});
