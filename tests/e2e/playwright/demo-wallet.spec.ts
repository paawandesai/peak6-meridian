import { test, expect } from "@playwright/test";

test.describe("Demo wallet (M4-07 AC9)", () => {
  test("offers demo wallet, connects, funds, and trades", async ({ page }) => {
    // Demo wallet is devnet-only per AC6
    const cluster = process.env.NEXT_PUBLIC_CLUSTER;
    test.skip(cluster !== "devnet", "Demo wallet only registers on devnet (AC6)");

    // Navigate to markets (root page)
    await page.goto("/");

    // Connect demo wallet
    await page.getByRole("button", { name: /connect wallet/i }).click();
    await expect(page.getByRole("button", { name: /try the demo/i })).toBeVisible();
    await page.getByRole("button", { name: /try the demo/i }).click();

    // Verify banner is shown
    await expect(page.getByText(/demo wallet.*devnet only/i)).toBeVisible();

    // Wait for funding to complete - check for USDC balance (formatUsdcBalance renders "N.NN test-USDC")
    // In localnet, the test harness faucet funds the wallet; in devnet, the real faucet does
    await expect(page.getByText(/[1-9].*test-USDC/i)).toBeVisible({ timeout: 10000 });

    // TODO: Once M2-06 Trade UI merges (!49), add full AC4/AC9 trade assertions:
    // - Navigate to a market
    // - Place one trade (select quantity, click Buy YES or Buy NO)
    // - Assert payoff sentence is shown before signing
    // - Click sign button
    // - Assert exactly one signature was requested (demo wallet auto-approves)
    // - Assert transaction confirmed
  });

  test("demo wallet not offered on mainnet", async ({ page }) => {
    const cluster = process.env.NEXT_PUBLIC_CLUSTER;
    test.skip(
      cluster === "devnet" || cluster === "localnet",
      "This test requires mainnet-beta or unset cluster",
    );
    await page.goto("/");
    await page.getByRole("button", { name: /connect wallet/i }).click();
    await expect(page.getByRole("button", { name: /try the demo/i })).not.toBeVisible();
  });
});
