import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CompactStrikeRow, LivePriceMarker } from "./compact-strike-row";
import type { MarketRow } from "@/lib/markets";

const createMockMarket = (strikeCents: bigint): MarketRow => ({
  address: "market-address",
  ticker: "AAPL",
  tradingDate: 20261010,
  strikeCents,
  closeTs: BigInt(Math.floor(Date.now() / 1000) + 28800),
  settled: false,
  outcome: "None",
  settlePriceScaled: 0n,
  pairsOutstanding: 100n,
  settledAt: 0n,
});

describe("CompactStrikeRow", () => {
  it("displays strike price", () => {
    const market = createMockMarket(18000n); // $180.00
    render(
      <CompactStrikeRow
        market={market}
        yesPriceCents={58}
        fairValueCents={null}
        edgeCents={null}
      />,
    );

    expect(screen.getByText("$180")).toBeInTheDocument();
  });

  it("displays YES price", () => {
    const market = createMockMarket(18000n);
    render(
      <CompactStrikeRow
        market={market}
        yesPriceCents={58}
        fairValueCents={null}
        edgeCents={null}
      />,
    );

    expect(screen.getByText("58¢")).toBeInTheDocument();
  });

  it("displays NO price as 100 - YES", () => {
    const market = createMockMarket(18000n);
    render(
      <CompactStrikeRow
        market={market}
        yesPriceCents={58}
        fairValueCents={null}
        edgeCents={null}
      />,
    );

    expect(screen.getByText("42¢")).toBeInTheDocument(); // 100 - 58
  });

  it("displays implied percent", () => {
    const market = createMockMarket(18000n);
    render(
      <CompactStrikeRow
        market={market}
        yesPriceCents={58}
        fairValueCents={null}
        edgeCents={null}
      />,
    );

    expect(screen.getByText("58%")).toBeInTheDocument();
  });

  it("renders probability bar with correct width", () => {
    const market = createMockMarket(18000n);
    render(
      <CompactStrikeRow
        market={market}
        yesPriceCents={65}
        fairValueCents={null}
        edgeCents={null}
      />,
    );

    const bar = screen.getByLabelText("65% probability");
    expect(bar).toHaveStyle({ width: "65%" });
  });

  it("shows positive edge chip when edge > 0", () => {
    const market = createMockMarket(18000n);
    render(
      <CompactStrikeRow market={market} yesPriceCents={60} fairValueCents={55} edgeCents={5} />,
    );

    const chip = screen.getByText("+5¢");
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveClass("bg-mer-gain/10");
  });

  it("shows negative edge chip when edge < 0", () => {
    const market = createMockMarket(18000n);
    render(
      <CompactStrikeRow market={market} yesPriceCents={50} fairValueCents={55} edgeCents={-5} />,
    );

    const chip = screen.getByText("-5¢");
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveClass("bg-mer-loss/10");
  });

  it("shows neutral edge chip when edge = 0", () => {
    const market = createMockMarket(18000n);
    render(
      <CompactStrikeRow market={market} yesPriceCents={55} fairValueCents={55} edgeCents={0} />,
    );

    const chip = screen.getByText("0¢");
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveClass("bg-mer-surface");
  });

  it("hides edge chip when fairValue is null", () => {
    const market = createMockMarket(18000n);
    render(
      <CompactStrikeRow
        market={market}
        yesPriceCents={58}
        fairValueCents={null}
        edgeCents={null}
      />,
    );

    // Edge chip text would contain + or - prefix and ¢ suffix (e.g., "+5¢" or "-3¢" or "0¢")
    // Without fairValue, only YES and NO prices (without +/- prefix) should be visible
    expect(screen.queryByText(/^[+-]\d+¢$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^0¢$/)).not.toBeInTheDocument();
  });

  it("calls onClick when row clicked", () => {
    const handleClick = vi.fn();
    const market = createMockMarket(18000n);
    render(
      <CompactStrikeRow
        market={market}
        yesPriceCents={58}
        fairValueCents={null}
        edgeCents={null}
        onClick={handleClick}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });
});

describe("LivePriceMarker", () => {
  it("displays price in dollars with 2 decimals", () => {
    const priceAsOf = Math.floor(Date.now() / 1000);
    render(<LivePriceMarker priceDollars={175.42} priceAsOf={priceAsOf} />);

    expect(screen.getByText("$175.42")).toBeInTheDocument();
  });

  it("displays as of time in ET", () => {
    const priceAsOf = 1728586800; // 2024-10-10 16:00:00 UTC = 12:00 PM ET
    render(<LivePriceMarker priceDollars={175.42} priceAsOf={priceAsOf} />);

    expect(screen.getByText(/as of/)).toBeInTheDocument();
  });

  it("renders horizontal line indicator", () => {
    const priceAsOf = Math.floor(Date.now() / 1000);
    const { container } = render(<LivePriceMarker priceDollars={175.42} priceAsOf={priceAsOf} />);

    const lines = container.querySelectorAll(".bg-mer-primary");
    expect(lines.length).toBeGreaterThanOrEqual(2); // Two line segments
  });
});
