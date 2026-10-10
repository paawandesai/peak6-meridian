import { test, expect } from "@playwright/test";
import { confirmedStatus, intentButton, priceInput, qtyInput, signButton } from "./support/ui";

// AC1: Demo wallet test runs with NEXT_PUBLIC_CLUSTER=devnet against the local harness.
// Run with E2E_DEMO_WALLET=1 to use global-setup-devnet.ts (starts app with devnet cluster).
// Skipped in the default `make e2e` (localnet) since registerDemoWallet() requires devnet (AC6).
test.skip(!process.env.E2E_DEMO_WALLET, "Demo wallet test requires E2E_DEMO_WALLET=1");

test.describe("Demo wallet (M4-07 AC9)", () => {
  test("offers demo wallet, connects, funds, and places a trade", async ({ page }) => {
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

    // AC9: Navigate to a market and place a trade
    // Click on the first market row to navigate to the trade page
    await page.locator("table tbody tr").first().click();
    await expect(page).toHaveURL(/\/trade\//);

    // Place a Buy YES trade (AC9)
    await intentButton(page, "Buy YES").click();
    await priceInput(page).fill("60");
    await qtyInput(page).fill("5");

    // AC4: Assert payoff sentence is visible before signing
    // The payoff sentence appears after filling in price and quantity
    // Format: "You pay $X.XX for N contracts. You win $Y.YY (profit $Z.ZZ) if TICKER closes above/below strike today. Max loss $X.XX."
    await expect(page.getByText(/You pay.*for.*contracts.*You win.*profit/i)).toBeVisible();

    // AC9: Click sign button - demo wallet auto-signs and sends exactly one signature request
    await signButton(page).click();

    // AC9: Assert exactly one signature request was made and transaction confirmed
    await expect(confirmedStatus(page)).toBeVisible({ timeout: 10000 });
    const sigCount = await page.evaluate(() => (window as any).__demoWallet?.signatureCount ?? 0);
    expect(sigCount, "AC9: exactly one auto-signed transaction").toBe(1);
  });

  test("demo wallet not offered on non-devnet", async () => {
    // AC6: This e2e would need NEXT_PUBLIC_CLUSTER=localnet, but the spec runs with E2E_DEMO_WALLET=1
    // (devnet). The AC6 guard (no registration on non-devnet) is verified by unit tests.
    test.skip(true, "AC6 guard tested in unit tests; e2e runs devnet-only via E2E_DEMO_WALLET");
  });
});
