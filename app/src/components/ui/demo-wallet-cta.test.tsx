import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DemoWalletCTA, FundToast } from "./demo-wallet-cta";

describe("DemoWalletCTA", () => {
  it("shows default text when not connecting", () => {
    const onConnect = vi.fn();
    render(<DemoWalletCTA onConnect={onConnect} />);

    expect(screen.getByRole("button", { name: "Try the demo wallet (devnet)" })).toBeInTheDocument();
  });

  it("shows connecting text when busy", () => {
    const onConnect = vi.fn();
    render(<DemoWalletCTA onConnect={onConnect} connecting />);

    expect(screen.getByRole("button", { name: "Connecting…" })).toBeInTheDocument();
  });

  it("disables button when connecting", () => {
    const onConnect = vi.fn();
    render(<DemoWalletCTA onConnect={onConnect} connecting />);

    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("calls onConnect when clicked", () => {
    const onConnect = vi.fn();
    render(<DemoWalletCTA onConnect={onConnect} />);

    screen.getByRole("button").click();

    expect(onConnect).toHaveBeenCalledOnce();
  });
});

describe("FundToast", () => {
  it("shows formatted USDC amount with thousands separator", () => {
    const onDismiss = vi.fn();
    render(<FundToast amountFunded={1_000_000_000n} onDismiss={onDismiss} />);

    expect(screen.getByText("+1,000 test-USDC")).toBeInTheDocument();
  });

  it("formats decimal amounts correctly", () => {
    const onDismiss = vi.fn();
    render(<FundToast amountFunded={1_500_000n} onDismiss={onDismiss} />);

    expect(screen.getByText("+1.5 test-USDC")).toBeInTheDocument();
  });

  it("has role status with aria-live polite", () => {
    const onDismiss = vi.fn();
    render(<FundToast amountFunded={1_000_000_000n} onDismiss={onDismiss} />);

    const toast = screen.getByRole("status");
    expect(toast).toHaveAttribute("aria-live", "polite");
  });

  it("calls onDismiss when close button clicked", () => {
    const onDismiss = vi.fn();
    render(<FundToast amountFunded={1_000_000_000n} onDismiss={onDismiss} />);

    screen.getByRole("button", { name: "Dismiss" }).click();

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("shows checkmark icon", () => {
    const onDismiss = vi.fn();
    render(<FundToast amountFunded={1_000_000_000n} onDismiss={onDismiss} />);

    expect(screen.getByText("✓")).toBeInTheDocument();
  });
});
