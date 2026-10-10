import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettledRow } from "./settled-row";
import type { MarketRow } from "@/lib/markets";

const baseMarket: MarketRow = {
  address: "test-market-address",
  ticker: "AAPL",
  tradingDate: 20261010,
  strikeCents: 68000n,
  closeTs: 1728576000n,
  settled: true,
  outcome: "Yes",
  settlePriceScaled: 681_230_000_000_000_000_000n, // $681.23
  pairsOutstanding: 100n,
  settledAt: 1728576300n,
};

describe("SettledRow", () => {
  it("shows settle price in dollars with oracle source", () => {
    const onRedeem = vi.fn();
    render(<SettledRow market={baseMarket} redeemLabel="Redeem" onRedeem={onRedeem} />);

    expect(screen.getByText(/Settled Yes at \$681\.23/)).toBeInTheDocument();
    expect(screen.getByText(/Pyth Pro, RedStone cross-check/)).toBeInTheDocument();
  });

  it("shows $1.00 / $0.00 per side for YES winner", () => {
    const onRedeem = vi.fn();
    render(<SettledRow market={baseMarket} redeemLabel="Redeem" onRedeem={onRedeem} />);

    expect(screen.getByText(/\$1\.00 \/ \$0\.00 per side/)).toBeInTheDocument();
  });

  it("shows $0.00 / $1.00 per side for NO winner", () => {
    const market: MarketRow = { ...baseMarket, outcome: "No" };
    const onRedeem = vi.fn();
    render(<SettledRow market={market} redeemLabel="Redeem" onRedeem={onRedeem} />);

    expect(screen.getByText(/Settled No at/)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.00 \/ \$1\.00 per side/)).toBeInTheDocument();
  });

  it("calls onRedeem when button clicked", () => {
    const onRedeem = vi.fn();
    render(<SettledRow market={baseMarket} redeemLabel="Redeem" onRedeem={onRedeem} />);

    const button = screen.getByRole("button", { name: "Redeem" });
    button.click();

    expect(onRedeem).toHaveBeenCalledOnce();
  });

  it("disables button when busy", () => {
    const onRedeem = vi.fn();
    render(<SettledRow market={baseMarket} redeemLabel="Redeem" onRedeem={onRedeem} busy />);

    const button = screen.getByRole("button", { name: "Redeeming…" });
    expect(button).toBeDisabled();
  });

  it("throws when market is not settled", () => {
    const market: MarketRow = { ...baseMarket, settled: false };
    const onRedeem = vi.fn();

    expect(() => render(<SettledRow market={market} redeemLabel="Redeem" onRedeem={onRedeem} />)).toThrow(
      /requires a settled market/,
    );
  });

  it("throws when outcome is None", () => {
    const market: MarketRow = { ...baseMarket, outcome: "None" };
    const onRedeem = vi.fn();

    expect(() => render(<SettledRow market={market} redeemLabel="Redeem" onRedeem={onRedeem} />)).toThrow(
      /requires a settled market/,
    );
  });
});
