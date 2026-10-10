import { test, expect } from "@playwright/test";

const BASE_URL = "https://peak6-meridian-nine.vercel.app";
const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844 },
  { name: "1280x800", width: 1280, height: 800 },
];

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name}`, () => {
    test.use({ viewport });

    test("/ (home)", async ({ page }) => {
      const pageerrors: string[] = [];
      page.on("pageerror", (e) => pageerrors.push(e.message));
      await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 30000 });
      expect(pageerrors.length, `Page errors on /: ${pageerrors.join(", ")}`).toBe(0);
    });

    test("/portfolio", async ({ page }) => {
      const pageerrors: string[] = [];
      page.on("pageerror", (e) => pageerrors.push(e.message));
      await page.goto(`${BASE_URL}/portfolio`, { waitUntil: "networkidle", timeout: 30000 });
      expect(pageerrors.length, `Page errors on /portfolio: ${pageerrors.join(", ")}`).toBe(0);
    });

    test("/status", async ({ page }) => {
      const pageerrors: string[] = [];
      page.on("pageerror", (e) => pageerrors.push(e.message));
      await page.goto(`${BASE_URL}/status`, { waitUntil: "networkidle", timeout: 30000 });
      expect(pageerrors.length, `Page errors on /status: ${pageerrors.join(", ")}`).toBe(0);
    });
  });
}
