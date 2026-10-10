/**
 * P0-2 standalone smoke test - runs against running app on port 3100
 * No fixtures - just page error/console tracking and chart AC3 assertions
 */
import { test, expect, type Page } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:3100';
const ROUTES = ['/', '/portfolio', '/status'];

async function checkPageErrors(page: Page, route: string): Promise<{ errors: string[], console429: string[] }> {
  const errors: string[] = [];
  const console429: string[] = [];

  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (text.includes('429') || text.includes('rate limit')) {
        console429.push(text);
      } else {
        errors.push(`[console.error] ${text}`);
      }
    }
  });

  await page.goto(`${BASE_URL}${route}`, { waitUntil: 'networkidle', timeout: 30000 });

  return { errors, console429 };
}

test.describe('P0-2 Mobile (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const route of ROUTES) {
    test(`${route} - zero page errors`, async ({ page }) => {
      const { errors, console429 } = await checkPageErrors(page, route);

      console.log(`Mobile ${route}:`);
      console.log(`  Page errors: ${errors.length}`);
      console.log(`  429/rate-limit console noise: ${console429.length}`);

      if (errors.length > 0) {
        console.log('  Errors:', JSON.stringify(errors, null, 2));
      }
      if (console429.length > 0) {
        console.log('  429 noise:', JSON.stringify(console429, null, 2));
      }

      expect(errors, `Zero page errors on mobile ${route}`).toEqual([]);
    });
  }

  test('chart collapsed by default', async ({ page }) => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });

    const disclosure = page.locator('details').filter({ hasText: 'Show price history' }).first();
    if (await disclosure.isVisible().catch(() => false)) {
      const isOpen = await disclosure.evaluate((el) => (el as HTMLDetailsElement).open);
      expect(isOpen, 'Chart should be collapsed by default').toBe(false);

      // Take screenshot of collapsed state
      await page.screenshot({ path: '/tmp/p0-2-mobile-collapsed.png', fullPage: true });
    }
  });

  test('chart expands and never blank - AC3', async ({ page }) => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });

    const summary = page.locator('summary').filter({ hasText: 'Show price history' }).first();
    if (await summary.isVisible().catch(() => false)) {
      await summary.click();
      await page.waitForTimeout(1000);

      // Take screenshot of expanded state
      await page.screenshot({ path: '/tmp/p0-2-mobile-expanded.png', fullPage: true });

      // AC3: Assert NOT an empty h-48 box - must have canvas with width > 0 OR status text
      const chartDiv = page.locator('.h-48').first();
      const canvas = chartDiv.locator('canvas').first();
      const statusText = page.locator('text=/Loading price history|No price history|Price history unavailable/').first();

      const hasCanvas = await canvas.isVisible().catch(() => false);
      const hasStatus = await statusText.isVisible().catch(() => false);

      let canvasWidth = 0;
      if (hasCanvas) {
        const box = await canvas.boundingBox();
        canvasWidth = box?.width ?? 0;
      }

      console.log('Mobile chart expanded:', { hasCanvas, canvasWidth, hasStatus });
      expect(
        (hasCanvas && canvasWidth > 0) || hasStatus,
        'AC3: Chart must show canvas with width > 0 or status text, never blank h-48 box'
      ).toBe(true);
    }
  });
});

test.describe('P0-2 Desktop (1280x800)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const route of ROUTES) {
    test(`${route} - zero page errors`, async ({ page }) => {
      const { errors, console429 } = await checkPageErrors(page, route);

      console.log(`Desktop ${route}:`);
      console.log(`  Page errors: ${errors.length}`);
      console.log(`  429/rate-limit console noise: ${console429.length}`);

      if (errors.length > 0) {
        console.log('  Errors:', JSON.stringify(errors, null, 2));
      }
      if (console429.length > 0) {
        console.log('  429 noise:', JSON.stringify(console429, null, 2));
      }

      expect(errors, `Zero page errors on desktop ${route}`).toEqual([]);
    });
  }

  test('chart collapsed by default', async ({ page }) => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });

    const disclosure = page.locator('details').filter({ hasText: 'Show price history' }).first();
    if (await disclosure.isVisible().catch(() => false)) {
      const isOpen = await disclosure.evaluate((el) => (el as HTMLDetailsElement).open);
      expect(isOpen, 'Chart should be collapsed by default').toBe(false);

      await page.screenshot({ path: '/tmp/p0-2-desktop-collapsed.png', fullPage: true });
    }
  });

  test('chart expands - AC3', async ({ page }) => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });

    const summary = page.locator('summary').filter({ hasText: 'Show price history' }).first();
    if (await summary.isVisible().catch(() => false)) {
      await summary.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: '/tmp/p0-2-desktop-expanded.png', fullPage: true });

      // AC3 verification: not a blank h-48 box
      const chartDiv = page.locator('.h-48').first();
      const canvas = chartDiv.locator('canvas').first();
      const statusText = page.locator('text=/Loading price history|No price history|Price history unavailable/').first();

      const hasCanvas = await canvas.isVisible().catch(() => false);
      const hasStatus = await statusText.isVisible().catch(() => false);

      let canvasWidth = 0;
      if (hasCanvas) {
        const box = await canvas.boundingBox();
        canvasWidth = box?.width ?? 0;
      }

      console.log('Desktop chart expanded:', { hasCanvas, canvasWidth, hasStatus });
      expect(
        (hasCanvas && canvasWidth > 0) || hasStatus,
        'AC3: Chart must show canvas with width > 0 or status text, never blank'
      ).toBe(true);
    }
  });
});
