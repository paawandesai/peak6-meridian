import { test, expect } from "@playwright/test";
import { confirmedStatus, intentButton, priceInput, qtyInput, signButton } from "./support/ui";

// AC1/AC9: Demo wallet happy path (connect, fund, trade) runs in `make e2e` with NEXT_PUBLIC_CLUSTER=devnet.
// AC6 registration guard (absence on non-devnet) is verified by unit tests in storage.test.ts.

test.describe("Demo wallet (M4-07)", () => {
  test("offers demo wallet, connects, funds, and places a trade", async ({ page }) => {
    // Navigate to markets (root page)
    await page.goto("/");

    // The demo wallet is offered twice: the header CTA (P0-6) and an entry in the connect modal
    // (M4-07). Both share the "Try the demo" name, so each is located by where it lives.
    await expect(page.getByTestId("demo-wallet-cta")).toHaveText("Try the demo wallet (devnet)");
    await page.getByRole("button", { name: /connect wallet/i }).click();
    const modalEntry = page.getByRole("dialog").getByRole("button", { name: /try the demo/i });
    await expect(modalEntry).toBeVisible();
    await modalEntry.click();

    // Verify banner is shown
    await expect(page.getByText(/demo wallet.*devnet only/i)).toBeVisible();

    // Wait for funding to complete - check for USDC balance (formatUsdcBalance renders "N.NN test-USDC")
    await expect(page.getByText(/[1-9].*test-USDC/i)).toBeVisible({ timeout: 10000 });

    // AC9: Navigate to a market and place a trade
    // Follow the first strike's Trade link (a session market, see global-setup) to its trade page
    await page
      .getByRole("link", { name: /^\$[\d,]+ Trade$/ })
      .first()
      .click();
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
    const sigCount = await page.evaluate(() => {
      const w = globalThis as typeof globalThis & { __demoWallet?: { signatureCount: number } };
      return w.__demoWallet?.signatureCount ?? 0;
    });
    expect(sigCount, "AC9: exactly one auto-signed transaction").toBe(1);
  });
});
