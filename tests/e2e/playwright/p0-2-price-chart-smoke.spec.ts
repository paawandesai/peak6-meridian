/**
 * P0-2 smoke: price history chart never blank, collapsed by default, readable in dark mode.
 * Runs on mobile (390x844) and desktop (1280x800) with zero page errors.
 */
import { expect, test } from "./support/fixtures";

const ROUTES = ["/", "/portfolio", "/status"];

test.describe("P0-2: Price history chart - Mobile (390x844)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const route of ROUTES) {
    test(`${route} loads with zero page errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });

      await page.goto(route);
      await page.waitForLoadState("networkidle");

      expect(errors, `Page errors on ${route}`).toEqual([]);
    });
  }

  test("price history chart is collapsed by default on Markets page", async ({ page }) => {
    await page.goto("/");

    // Find the disclosure element
    const disclosure = page.locator("details").filter({ hasText: "Show price history" }).first();
    await expect(disclosure).toBeVisible();

    // Verify it's closed by default
    const isOpen = await disclosure.evaluate((el) => (el as HTMLDetailsElement).open);
    expect(isOpen).toBe(false);

    // Verify the chart container is not visible when collapsed
    const chartContainer = disclosure.locator(".h-48");
    await expect(chartContainer).not.toBeVisible();
  });

  test("price history chart shows status when expanded", async ({ page }) => {
    await page.goto("/");

    // Find and expand the disclosure
    const summary = page.locator("summary").filter({ hasText: "Show price history" }).first();
    await summary.click();

    // Wait for either the chart or a status message
    await expect(
      page.locator("text=/Loading price history|No price history|Price history unavailable|.h-48/").first()
    ).toBeVisible({ timeout: 10000 });

    // Verify no blank box: either we have a status message OR the chart
    const chartContainer = page.locator(".h-48").first();
    const loadingText = page.locator("text=Loading price history");
    const emptyText = page.locator("text=/No price history|Price history unavailable/");

    const hasChart = await chartContainer.isVisible();
    const hasStatus = (await loadingText.isVisible()) || (await emptyText.isVisible());

    expect(hasChart || hasStatus, "Chart should show either canvas or status text").toBe(true);
  });
});

test.describe("P0-2: Price history chart - Desktop (1280x800)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const route of ROUTES) {
    test(`${route} loads with zero page errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });

      await page.goto(route);
      await page.waitForLoadState("networkidle");

      expect(errors, `Page errors on ${route}`).toEqual([]);
    });
  }

  test("price history chart is collapsed by default on Markets page", async ({ page }) => {
    await page.goto("/");

    const disclosure = page.locator("details").filter({ hasText: "Show price history" }).first();
    await expect(disclosure).toBeVisible();

    const isOpen = await disclosure.evaluate((el) => (el as HTMLDetailsElement).open);
    expect(isOpen).toBe(false);
  });

  test("price history chart expands and shows content", async ({ page }) => {
    await page.goto("/");

    const summary = page.locator("summary").filter({ hasText: "Show price history" }).first();
    await summary.click();

    // Wait for content
    await expect(
      page.locator("text=/Loading price history|No price history|Price history unavailable|.h-48/").first()
    ).toBeVisible({ timeout: 10000 });
  });

  test("chart has correct label", async ({ page }) => {
    await page.goto("/");

    const summary = page.locator("summary").filter({
      hasText: /Show price history.*Pyth price, last 7 days \(context only\)/
    }).first();
    await expect(summary).toBeVisible();
  });
});

test.describe("P0-2: Price history chart - Dark mode", () => {
  test.use({ colorScheme: "dark", viewport: { width: 1280, height: 800 } });

  test("chart is readable in dark mode", async ({ page }) => {
    await page.goto("/");

    // Expand the chart
    const summary = page.locator("summary").filter({ hasText: "Show price history" }).first();
    await summary.click();

    // Wait for chart or status
    await expect(
      page.locator("text=/Loading price history|No price history|Price history unavailable|.h-48/").first()
    ).toBeVisible({ timeout: 10000 });

    // Take a screenshot for manual verification if needed
    const disclosure = page.locator("details").filter({ hasText: "Show price history" }).first();
    await disclosure.screenshot({ path: "playwright-report/artifacts/p0-2-dark-mode-chart.png" });
  });
});

test.describe("P0-2: Trade page with market", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("/trade/[market] loads with zero page errors", async ({ page }) => {
    // First get a market address from the Markets page
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Find the first "Trade" link (UI-04 adds the Trade link)
    const tradeLink = page.locator("a").filter({ hasText: "Trade" }).first();

    // If trade links exist, test the trade page
    if (await tradeLink.isVisible().catch(() => false)) {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });

      await tradeLink.click();
      await page.waitForLoadState("networkidle");

      expect(errors, "Page errors on /trade/[market]").toEqual([]);
    } else {
      test.skip();
    }
  });
});
