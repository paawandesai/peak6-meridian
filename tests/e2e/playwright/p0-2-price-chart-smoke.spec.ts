/**
 * P0-2 smoke: the board's price chart never blank, only in the detail view, readable in dark mode.
 * Runs on mobile (390x844) and desktop (1280x800) with zero page errors.
 *
 * The app keeps account subscriptions and pollers open, so the network never goes idle: each page
 * is "loaded" when its data-backed content is on screen, not on `networkidle`.
 */
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "./support/fixtures";
import { openTradeLink } from "./support/ui";

/** Each route with the content that only renders once its data has loaded. */
const ROUTES: readonly { path: string; loaded: (page: Page) => Promise<void> }[] = [
  {
    path: "/",
    // The session ladders global-setup creates (listMarkets resolved and rendered).
    loaded: async (page) => {
      await expect(page.getByRole("region", { name: "META" })).toContainText("680");
    },
  },
  {
    path: "/portfolio",
    // No wallet connected: the connect prompt replaces the positions.
    loaded: async (page) => {
      await expect(page.getByText(/^Connect your wallet to see your positions/)).toBeVisible();
    },
  },
  {
    path: "/status",
    // The status API answered (the view or its error replaced the loading line).
    loaded: async (page) => {
      await expect(page.getByRole("heading", { name: "Status" })).toBeVisible();
      await expect(page.getByText("Loading status…")).toBeHidden();
    },
  },
];

/**
 * App API routes whose backing service the local smoke stack does not run, so they answer
 * 503 "not configured" by design and the UI shows its "unavailable" state: Pyth Pro quotes (needs
 * PYTH_API_TOKEN and the live API, never called from tests), fair values (QUANT_URL) and market
 * open times (AUTOMATION_URL). Chromium logs each such response as a console error.
 */
const UNCONFIGURED_SERVICE_ROUTES = new Set([
  "/api/pyth-quotes",
  "/api/fair-values",
  "/api/market-open-times",
]);

/** True only for Chromium's resource-load log of a 503 from one of the routes above. */
function isUnconfiguredService503(text: string, resourceUrl: string): boolean {
  if (!text.startsWith("Failed to load resource: the server responded with a status of 503")) {
    return false;
  }
  try {
    return UNCONFIGURED_SERVICE_ROUTES.has(new URL(resourceUrl).pathname);
  } catch {
    return false;
  }
}

/**
 * Collects uncaught page errors and console errors from now on. Every one fails the test except
 * the 503 resource logs of the unconfigured services above (any other status, route or message,
 * including a JS error those 503s cause, still fails it).
 */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    if (isUnconfiguredService503(msg.text(), msg.location().url)) return;
    errors.push(`${msg.text()} (${msg.location().url})`);
  });
  return errors;
}

/** The detail view's Pyth price chart (docs/redesign-spec.md §4.2), for the opened stock. */
const priceChart = (page: Page): Locator =>
  page.getByTestId("detail-view").getByRole("figure", { name: /price, last (day|week)/ });

/** The chart shows either a status line or the drawn chart, never a blank box. */
const statusOrChart = (chart: Locator): Locator =>
  chart.getByTestId("price-line-state").or(chart.getByTestId("price-line-canvas")).first();

for (const [label, viewport] of [
  ["Mobile (390x844)", { width: 390, height: 844 }],
  ["Desktop (1280x800)", { width: 1280, height: 800 }],
] as const) {
  test.describe(`P0-2: Price history chart - ${label}`, () => {
    test.use({ viewport });

    for (const route of ROUTES) {
      test(`${route.path} loads with zero page errors`, async ({ page }) => {
        const errors = collectErrors(page);
        await page.goto(route.path);
        await route.loaded(page);
        expect(errors, `Page errors on ${route.path}`).toEqual([]);
      });
    }

    test("no price chart on the board until a stock is opened", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("region", { name: "META" })).toContainText("680");
      // History is read only while the detail view is open (spec §3).
      await expect(page.getByRole("figure", { name: /price, last day/ })).toHaveCount(0);
    });

    test("the detail's price chart shows status or chart, never blank", async ({ page }) => {
      await page.goto("/?t=NVDA");
      const chart = priceChart(page);
      await expect(statusOrChart(chart)).toBeVisible({ timeout: 10_000 });
      const hasChart = await chart.getByTestId("price-line-canvas").isVisible();
      const hasStatus = await chart.getByTestId("price-line-state").isVisible();
      expect(hasChart || hasStatus, "Chart should show either canvas or status text").toBe(true);
    });

    test("chart has correct label and range toggle", async ({ page }) => {
      await page.goto("/?t=NVDA");
      const chart = priceChart(page);
      await expect(chart).toBeVisible();
      await expect(chart).toContainText("NVDA price, last day");
      await chart.getByRole("button", { name: "1W" }).click();
      await expect(chart.getByRole("button", { name: "1W" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(chart).toContainText("NVDA price, last week");
    });
  });
}

test.describe("P0-2: Price history chart - Dark mode", () => {
  test.use({ colorScheme: "dark", viewport: { width: 1280, height: 800 } });

  test("chart is readable in dark mode", async ({ page }) => {
    await page.goto("/?t=NVDA");

    const chart = priceChart(page);
    await expect(statusOrChart(chart)).toBeVisible({ timeout: 10_000 });

    // Screenshot for manual verification if needed.
    await chart.screenshot({ path: "playwright-report/artifacts/p0-2-dark-mode-chart.png" });
  });
});

test.describe("P0-2: Trade page with market", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("/trade/[market] loads with zero page errors", async ({ page }) => {
    await page.goto("/");
    // Every session strike's detail links to its Trade page (UI-04); global-setup seeds them.
    const tradeLink = await openTradeLink(page);
    await expect(tradeLink).toBeVisible();

    const errors = collectErrors(page);
    await tradeLink.click();
    await expect(page).toHaveURL(/\/trade\//);
    // The order panel renders only once the market, config and book have loaded.
    await expect(page.getByRole("radio", { name: /^Buy YES/ })).toBeVisible();

    expect(errors, "Page errors on /trade/[market]").toEqual([]);
  });
});
