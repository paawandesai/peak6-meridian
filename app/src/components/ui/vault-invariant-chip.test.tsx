import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { VaultInvariantChip } from "./vault-invariant-chip";

describe("VaultInvariantChip", () => {
  const NOW = Math.floor(Date.parse("2026-10-08T19:52:05Z") / 1000); // 15:52:05 ET

  it("shows pass (✓) when vault equals pairs × $1", () => {
    // 1,240 pairs = 1,240,000,000 base units vault
    const vault = 1_240_000_000n;
    const pairs = 1_240n;
    render(<VaultInvariantChip vaultBalanceBaseUnits={vault} pairsOutstanding={pairs} asOfSecs={NOW} />);

    expect(screen.getByTestId("vault-invariant-chip")).toHaveTextContent(/Vault \$1,240\.00 = 1,240 pairs × \$1\.00/);
    expect(screen.getByTestId("vault-invariant-chip")).toHaveTextContent("✓");
    expect(screen.getByLabelText("Pass")).toBeInTheDocument();
  });

  it("shows fail (✗) when vault does not equal pairs × $1", () => {
    // Vault is off by 1 base unit (should never happen)
    const vault = 1_240_000_001n;
    const pairs = 1_240n;
    render(<VaultInvariantChip vaultBalanceBaseUnits={vault} pairsOutstanding={pairs} asOfSecs={NOW} />);

    expect(screen.getByTestId("vault-invariant-chip")).toHaveTextContent("✗");
    expect(screen.getByLabelText("Fail")).toBeInTheDocument();
  });

  it("formats large numbers with thousands separators", () => {
    const vault = 1_234_567_000_000n; // 1,234,567 USDC
    const pairs = 1_234_567n;
    render(<VaultInvariantChip vaultBalanceBaseUnits={vault} pairsOutstanding={pairs} asOfSecs={NOW} />);

    expect(screen.getByTestId("vault-invariant-chip")).toHaveTextContent("Vault $1,234,567.00 = 1,234,567 pairs");
  });

  it("shows as-of time in ET", () => {
    const vault = 100_000_000n;
    const pairs = 100n;
    render(<VaultInvariantChip vaultBalanceBaseUnits={vault} pairsOutstanding={pairs} asOfSecs={NOW} />);

    expect(screen.getByTestId("vault-invariant-chip")).toHaveTextContent("(as of 15:52:05 ET)");
  });

  it("links to /status by default", () => {
    const vault = 100_000_000n;
    const pairs = 100n;
    render(<VaultInvariantChip vaultBalanceBaseUnits={vault} pairsOutstanding={pairs} asOfSecs={NOW} />);

    const link = screen.getByTestId("vault-invariant-chip");
    expect(link).toHaveAttribute("href", "/status");
  });

  it("accepts custom status href", () => {
    const vault = 100_000_000n;
    const pairs = 100n;
    render(<VaultInvariantChip vaultBalanceBaseUnits={vault} pairsOutstanding={pairs} asOfSecs={NOW} statusHref="/custom" />);

    const link = screen.getByTestId("vault-invariant-chip");
    expect(link).toHaveAttribute("href", "/custom");
  });

  it("handles zero pairs and vault", () => {
    render(<VaultInvariantChip vaultBalanceBaseUnits={0n} pairsOutstanding={0n} asOfSecs={NOW} />);

    expect(screen.getByTestId("vault-invariant-chip")).toHaveTextContent("Vault $0.00 = 0 pairs × $1.00");
    expect(screen.getByTestId("vault-invariant-chip")).toHaveTextContent("✓");
  });
});
