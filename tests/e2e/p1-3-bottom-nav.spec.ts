import { test, expect } from "@playwright/test";

const ROUTES = [
  { path: "/", label: "Markets" },
  { path: "/portfolio", label: "Portfolio" },
  { path: "/history", label: "History" },
  { path: "/status", label: "Status" },
];

test.describe("P1-3 Bottom Navigation", () => {
  test.use({ viewport: { width: 390, height: 844 } }); // iPhone 12 Pro

  for (const route of ROUTES) {
    test(`shows bottom nav on ${route.label} at 390px`, async ({ page }) => {
      await page.goto(`http://localhost:3000${route.path}`);

      // Wait for page to load
      await page.waitForLoadState("load");

      // Bottom nav should be visible
      const nav = page.locator('nav[aria-label="Main navigation"]');
      await expect(nav).toBeVisible();

      // All 4 tabs should be present
      for (const r of ROUTES) {
        const tab = page.locator(`a[href="${r.path}"]`).filter({ hasText: r.label });
        await expect(tab).toBeVisible();

        // Check 44px min height
        const box = await tab.boundingBox();
        expect(box?.height).toBeGreaterThanOrEqual(44);
      }

      // Current tab should have aria-current="page"
      const activeTab = page.locator(`a[href="${route.path}"]`).filter({ hasText: route.label });
      await expect(activeTab).toHaveAttribute("aria-current", "page");

      // Other tabs should NOT have aria-current
      for (const r of ROUTES) {
        if (r.path !== route.path) {
          const inactiveTab = page.locator(`a[href="${r.path}"]`).filter({ hasText: r.label });
          await expect(inactiveTab).not.toHaveAttribute("aria-current");
        }
      }

      // Check focus ring (test that focus:ring-2 class exists)
      const firstTab = page.locator('nav[aria-label="Main navigation"] a').first();
      const classes = await firstTab.getAttribute("class");
      expect(classes).toContain("focus:ring-2");

      // Take screenshot
      await page.screenshot({
        path: `p1-3-${route.label.toLowerCase()}-390px.png`,
        fullPage: true,
      });
    });
  }
});
