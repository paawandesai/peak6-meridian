import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PortfolioFilters, type PortfolioTotals } from "./portfolio-filters";

const baseTotals: PortfolioTotals = {
  usdcBalance: 1_000_000_000n, // $1,000.00
  redeemableNow: 250_000_000n, // $250.00
  unrealizedCents: 123_450_000n, // +$123.45 (in USDC base units)
  realizedCents: 0n,
};

describe("PortfolioFilters", () => {
  it("displays totals line with formatted values", () => {
    const onTabChange = vi.fn();
    render(<PortfolioFilters activeTab="open" onTabChange={onTabChange} totals={baseTotals} />);

    expect(screen.getByText("1,000.00 test-USDC")).toBeInTheDocument();
    expect(screen.getByText(/Redeemable now/)).toBeInTheDocument();
    expect(screen.getByText("$250.00")).toBeInTheDocument();
    expect(screen.getByText(/Unrealized/)).toBeInTheDocument();
    expect(screen.getByText("+$123.45")).toBeInTheDocument();
  });

  it("shows negative unrealized P&L in red", () => {
    const totals: PortfolioTotals = { ...baseTotals, unrealizedCents: -50_000_000n }; // -$50.00
    const onTabChange = vi.fn();
    render(<PortfolioFilters activeTab="open" onTabChange={onTabChange} totals={totals} />);

    const pnlElement = screen.getByText("−$50.00");
    expect(pnlElement).toHaveClass("text-mer-loss");
  });

  it("shows positive unrealized P&L in green", () => {
    const onTabChange = vi.fn();
    render(<PortfolioFilters activeTab="open" onTabChange={onTabChange} totals={baseTotals} />);

    const pnlElement = screen.getByText("+$123.45");
    expect(pnlElement).toHaveClass("text-mer-gain");
  });

  it("shows zero unrealized P&L without color", () => {
    const totals: PortfolioTotals = { ...baseTotals, unrealizedCents: 0n };
    const onTabChange = vi.fn();
    render(<PortfolioFilters activeTab="open" onTabChange={onTabChange} totals={totals} />);

    // Find the Unrealized span and check its nested mer-num span
    const unrealizedSpan = screen.getByText(/Unrealized/).closest("span");
    expect(unrealizedSpan).toBeInTheDocument();
    const pnlElement = unrealizedSpan?.querySelector(".mer-num");
    expect(pnlElement).not.toHaveClass("text-mer-gain");
    expect(pnlElement).not.toHaveClass("text-mer-loss");
  });

  it("renders three filter tabs", () => {
    const onTabChange = vi.fn();
    render(<PortfolioFilters activeTab="open" onTabChange={onTabChange} totals={baseTotals} />);

    expect(screen.getByRole("tab", { name: "Open" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Resting orders" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Closed" })).toBeInTheDocument();
  });

  it("marks active tab with aria-selected", () => {
    const onTabChange = vi.fn();
    render(<PortfolioFilters activeTab="resting" onTabChange={onTabChange} totals={baseTotals} />);

    expect(screen.getByRole("tab", { name: "Open" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "Resting orders" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Closed" })).toHaveAttribute("aria-selected", "false");
  });

  it("calls onTabChange when tab clicked", () => {
    const onTabChange = vi.fn();
    render(<PortfolioFilters activeTab="open" onTabChange={onTabChange} totals={baseTotals} />);

    screen.getByRole("tab", { name: "Closed" }).click();

    expect(onTabChange).toHaveBeenCalledWith("closed");
  });

  it("formats USDC with thousands separators", () => {
    const totals: PortfolioTotals = {
      usdcBalance: 1_234_567_890_000n, // $1,234,567.89
      redeemableNow: 0n,
      unrealizedCents: 0n,
      realizedCents: 0n,
    };
    const onTabChange = vi.fn();
    render(<PortfolioFilters activeTab="open" onTabChange={onTabChange} totals={totals} />);

    expect(screen.getByText("1,234,567.89 test-USDC")).toBeInTheDocument();
  });
});
