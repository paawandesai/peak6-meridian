import { test, expect } from "@playwright/test";

test.describe("Demo wallet (M4-07 AC9)", () => {
  test("offers demo wallet on devnet, connects and funds", async ({ page }) => {
    await page.goto("/markets");
    await page.getByRole("button", { name: /connect wallet/i }).click();
    await expect(page.getByRole("button", { name: /try the demo/i })).toBeVisible();
    await page.getByRole("button", { name: /try the demo/i }).click();
    await expect(page.getByText(/demo wallet.*devnet only/i)).toBeVisible();
    await page.waitForTimeout(3000);
    const balanceText = await page.locator("text=/\\$\\d+/").first().textContent();
    expect(balanceText).toBeTruthy();
  });

  test("demo wallet not offered on non-devnet cluster", async ({ page }) => {
    test.skip(
      process.env.NEXT_PUBLIC_CLUSTER === "devnet",
      "This test requires non-devnet cluster",
    );
    await page.goto("/markets");
    await page.getByRole("button", { name: /connect wallet/i }).click();
    await expect(page.getByRole("button", { name: /try the demo/i })).not.toBeVisible();
  });
});
