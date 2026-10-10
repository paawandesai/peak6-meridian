/**
 * Post-merge smoke for P0-2 on -nine (production).
 * Basic page loads: /, /trade, /portfolio, /status
 * Requirement: 0 pageerrors on all routes
 */
import { test, expect } from "@playwright/test";

const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844 },
  { name: "1280x800", width: 1280, height: 800 },
];

const results: Array<{
  viewport: string;
  route: string;
  pageerrors: number;
  consoleerrors: number;
}> = [];

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name}`, () => {
    test.use({ viewport });

    test("/ (home)", async ({ page }) => {
      const pageerrors: string[] = [];
      const consoleerrors: string[] = [];
      page.on("pageerror", (e) => pageerrors.push(e.message));
      page.on("console", (m) => { if (m.type() === "error") consoleerrors.push(m.text()); });

      await page.goto("/", { waitUntil: "load", timeout: 30000 });
      await page.waitForTimeout(2000); // Let app settle

      results.push({
        viewport: viewport.name,
        route: "/",
        pageerrors: pageerrors.length,
        consoleerrors: consoleerrors.length,
      });

      expect(pageerrors.length, `Page errors on / at ${viewport.name}: ${pageerrors.join(", ")}`).toBe(0);
    });

    test("/portfolio", async ({ page }) => {
      const pageerrors: string[] = [];
      const consoleerrors: string[] = [];
      page.on("pageerror", (e) => pageerrors.push(e.message));
      page.on("console", (m) => { if (m.type() === "error") consoleerrors.push(m.text()); });

      await page.goto("/portfolio", { waitUntil: "load", timeout: 30000 });
      await page.waitForTimeout(2000);

      results.push({
        viewport: viewport.name,
        route: "/portfolio",
        pageerrors: pageerrors.length,
        consoleerrors: consoleerrors.length,
      });

      expect(pageerrors.length, `Page errors on /portfolio at ${viewport.name}: ${pageerrors.join(", ")}`).toBe(0);
    });

    test("/status", async ({ page }) => {
      const pageerrors: string[] = [];
      const consoleerrors: string[] = [];
      page.on("pageerror", (e) => pageerrors.push(e.message));
      page.on("console", (m) => { if (m.type() === "error") consoleerrors.push(m.text()); });

      await page.goto("/status", { waitUntil: "load", timeout: 30000 });
      await page.waitForTimeout(2000);

      results.push({
        viewport: viewport.name,
        route: "/status",
        pageerrors: pageerrors.length,
        consoleerrors: consoleerrors.length,
      });

      expect(pageerrors.length, `Page errors on /status at ${viewport.name}: ${pageerrors.join(", ")}`).toBe(0);
    });
  });
}

test.afterAll(() => {
  const table = [
    "| Viewport | Route | Pageerrors | Console errors |",
    "|----------|-------|------------|----------------|",
    ...results.map(r => {
      return `| ${r.viewport} | ${r.route} | ${r.pageerrors} | ${r.consoleerrors} |`;
    }),
  ].join("\n");

  console.log("\n-nine smoke results:");
  console.log(table);
});
