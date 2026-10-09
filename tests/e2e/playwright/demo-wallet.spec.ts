import { test, expect } from "@playwright/test";

test.describe("Demo wallet (M4-07 AC9)", () => {
  test("offers demo wallet on devnet, connects, funds, and trades", async ({ page }) => {
    test.skip(process.env.NEXT_PUBLIC_CLUSTER !== "devnet", "This test requires devnet cluster");

    // Navigate to markets (root page)
    await page.goto("/");

    // Connect demo wallet
    await page.getByRole("button", { name: /connect wallet/i }).click();
    await expect(page.getByRole("button", { name: /try the demo/i })).toBeVisible();
    await page.getByRole("button", { name: /try the demo/i }).click();

    // Verify banner is shown
    await expect(page.getByText(/demo wallet.*devnet only/i)).toBeVisible();

    // Wait for funding to complete - check for USDC balance (formatUsdcBalance renders "N.NN test-USDC")
    await expect(page.getByText(/[1-9].*test-USDC/i)).toBeVisible({ timeout: 10000 });

    // TODO: Once M2-06 Trade UI merges (!49), add assertions for AC4/AC9:
    // - Navigate to a market
    // - Place one trade (select quantity, click Buy YES or Buy NO)
    // - Assert payoff sentence is shown before signing
    // - Click sign button
    // - Assert exactly one signature was requested (via injected test wallet's counter)
    // - Assert transaction confirmed
    // Keep this spec test.fixme until that UI exists, then remove fixme and implement.
  });

  test("demo wallet not offered on non-devnet cluster", async ({ page }) => {
    test.skip(
      process.env.NEXT_PUBLIC_CLUSTER === "devnet",
      "This test requires non-devnet cluster",
    );
    await page.goto("/");
    await page.getByRole("button", { name: /connect wallet/i }).click();
    await expect(page.getByRole("button", { name: /try the demo/i })).not.toBeVisible();
  });
});
