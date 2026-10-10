import { render, screen, within } from "@testing-library/react";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { VaultInvariantChip, vaultChipText } from "./vault-invariant-chip";
import { StatusView } from "@/app/status/status-view";
import { NO_FACTS, vaultInvariant } from "@/lib/status";
import { formatEtHms } from "@/lib/time";
import { market } from "@/test-utils";

// 2026-10-08 14:52:05 ET (EDT, UTC−4) = 18:52:05Z.
const AS_OF = Math.floor(Date.parse("2026-10-08T18:52:05Z") / 1000);

describe("vaultChipText (P0-7 AC5, FR-29)", () => {
  it("passes when the vault is exactly pairs × 1,000,000 base units", () => {
    expect(vaultChipText({ pairs: 1_240n, balance: 1_240_000_000n, asOfSecs: AS_OF })).toBe(
      "Vault 1,240.00 test-USDC = 1,240 pairs × $1.00 ✓ Pass (as of 14:52:05 ET)",
    );
  });

  it("fails in words on any mismatch, one base unit either way", () => {
    expect(vaultChipText({ pairs: 1_240n, balance: 1_239_999_999n, asOfSecs: AS_OF })).toBe(
      "Vault 1,239.99 test-USDC ≠ 1,240 pairs × $1.00 ✕ Fail (as of 14:52:05 ET)",
    );
    expect(vaultChipText({ pairs: 1_240n, balance: 1_240_000_001n, asOfSecs: AS_OF })).toContain(
      "✕ Fail",
    );
  });

  it("an unreadable vault or market is a Fail, never a silent Pass or a zero", () => {
    expect(vaultChipText({ pairs: 5n, balance: null, asOfSecs: AS_OF })).toBe(
      "Vault unavailable ≠ 5 pairs × $1.00 ✕ Fail (as of 14:52:05 ET)",
    );
    expect(vaultChipText({ pairs: null, balance: 5_000_000n, asOfSecs: AS_OF })).toMatch(
      /^Vault invariant unavailable: .* ✕ Fail \(as of 14:52:05 ET\)$/,
    );
  });

  it("says loading before the first read", () => {
    expect(vaultChipText({ pairs: null, balance: null, asOfSecs: null })).toBe(
      "Vault invariant loading…",
    );
  });

  it("Pass iff balance = pairs × 1,000,000 for any integers", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        (pairs, balance) => {
          const text = vaultChipText({ pairs, balance, asOfSecs: AS_OF });
          const pass = balance === pairs * 1_000_000n;
          expect(text.includes("✓ Pass")).toBe(pass);
          expect(text.includes("✕ Fail")).toBe(!pass);
        },
      ),
    );
  });
});

describe("VaultInvariantChip", () => {
  it("links to /status and carries the verdict as text and a data attribute", () => {
    render(<VaultInvariantChip pairs={3n} balance={3_000_000n} asOfSecs={AS_OF} />);
    const chip = screen.getByTestId("vault-chip");
    expect(chip).toHaveAttribute("href", "/status");
    expect(chip).toHaveAttribute("data-verdict", "Pass");
    expect(chip).toHaveTextContent(`(as of ${formatEtHms(AS_OF)} ET)`);
  });

  it("marks a mismatch Fail", () => {
    render(<VaultInvariantChip pairs={3n} balance={2_000_000n} asOfSecs={AS_OF} />);
    expect(screen.getByTestId("vault-chip")).toHaveAttribute("data-verdict", "Fail");
  });

  it("prints the same expected, actual and verdict as /status for the same market", () => {
    const row = market({
      address: "Same",
      ticker: "NVDA",
      strikeCents: 18_000n,
      pairsOutstanding: 1_240n,
    });
    const balance = 1_240_000_000n;
    render(
      <StatusView
        data={{
          markets: [row],
          vaults: new Map([[row.address, balance]]),
          facts: new Map([[row.address, NO_FACTS]]),
        }}
      />,
    );
    // The first table on /status is the vault invariant table.
    const statusRow = screen.getAllByRole("rowheader", { name: "NVDA ≥ $180" })[0]?.closest("tr");
    if (statusRow === null || statusRow === undefined) throw new Error("no /status row");
    const cells = within(statusRow)
      .getAllByRole("cell")
      .map((cell) => cell.textContent);
    render(<VaultInvariantChip pairs={row.pairsOutstanding} balance={balance} asOfSecs={AS_OF} />);
    const chip = screen.getByTestId("vault-chip").textContent ?? "";
    // /status: pairs, expected vault, actual vault, verdict.
    expect(cells[0]).toBe("1240");
    expect(chip).toContain(`Vault ${cells[2]} = 1,240 pairs`);
    expect(cells[1]).toBe(cells[2]);
    expect(cells[3]).toContain(vaultInvariant(row.pairsOutstanding, balance).verdict);
    expect(chip).toContain("Pass");
  });
});
