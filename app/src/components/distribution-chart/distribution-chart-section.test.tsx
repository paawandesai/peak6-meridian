import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DistributionChartSection } from "./distribution-chart-section";
import type { DistributionPoint } from "./distribution";

// Mock the DistributionChart component
vi.mock("./distribution-chart", () => ({
  DistributionChart: ({ ticker }: { ticker: string }) => (
    <div data-testid="distribution-chart">Chart for {ticker}</div>
  ),
}));

describe("DistributionChartSection", () => {
  const points: DistributionPoint[] = [
    { strikeCents: 680_00n, yesCents: 60, fairCents: 58, market: "market-1" },
    { strikeCents: 700_00n, yesCents: 40, fairCents: 42, market: "market-2" },
  ];

  let originalInnerWidth: number;

  beforeEach(() => {
    originalInnerWidth = window.innerWidth;
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: originalInnerWidth,
    });
  });

  it("shows empty state when no points", () => {
    render(<DistributionChartSection ticker="NVDA" points={[]} />);

    expect(screen.getByTestId("distribution-section")).toHaveTextContent(
      "Distribution chart: no data available for NVDA"
    );
    expect(screen.queryByTestId("distribution-chart")).not.toBeInTheDocument();
  });

  it("renders chart when points are provided", () => {
    render(<DistributionChartSection ticker="NVDA" points={points} defaultCollapsed={false} />);

    expect(screen.getByTestId("distribution-chart")).toHaveTextContent("Chart for NVDA");
  });

  it("toggles collapsed state on button click", () => {
    render(<DistributionChartSection ticker="NVDA" points={points} defaultCollapsed={true} />);

    // Initially collapsed
    expect(screen.queryByTestId("distribution-chart")).not.toBeInTheDocument();

    // Click to expand
    fireEvent.click(screen.getByTestId("distribution-toggle"));
    expect(screen.getByTestId("distribution-chart")).toBeInTheDocument();

    // Click to collapse
    fireEvent.click(screen.getByTestId("distribution-toggle"));
    expect(screen.queryByTestId("distribution-chart")).not.toBeInTheDocument();
  });

  it("defaults to collapsed on mobile width", () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 390, // Mobile
    });

    render(<DistributionChartSection ticker="NVDA" points={points} />);

    // Should be collapsed by default on mobile
    expect(screen.queryByTestId("distribution-chart")).not.toBeInTheDocument();
  });

  it("defaults to open on desktop width", () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 1280, // Desktop
    });

    render(<DistributionChartSection ticker="NVDA" points={points} />);

    // Should be open by default on desktop
    expect(screen.getByTestId("distribution-chart")).toBeInTheDocument();
  });

  it("respects explicit defaultCollapsed prop", () => {
    render(<DistributionChartSection ticker="NVDA" points={points} defaultCollapsed={false} />);

    expect(screen.getByTestId("distribution-chart")).toBeInTheDocument();
  });

  it("shows correct aria-expanded state", () => {
    render(<DistributionChartSection ticker="NVDA" points={points} defaultCollapsed={true} />);

    const toggle = screen.getByTestId("distribution-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });
});
