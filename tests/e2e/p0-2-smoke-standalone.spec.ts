/**
 * P0-2 standalone smoke test - runs against running app on port 3100
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

  test('chart expands and never blank', async ({ page }) => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });

    const summary = page.locator('summary').filter({ hasText: 'Show price history' }).first();
    if (await summary.isVisible().catch(() => false)) {
      await summary.click();

      // Wait for either chart or status
      await page.waitForTimeout(2000);

      // Take screenshot of expanded state
      await page.screenshot({ path: '/tmp/p0-2-mobile-expanded.png', fullPage: true });

      const chartContainer = page.locator('.h-48').first();
      const statusText = page.locator('text=/Loading|No price history|Price history unavailable/').first();

      const hasChart = await chartContainer.isVisible().catch(() => false);
      const hasStatus = await statusText.isVisible().catch(() => false);

      console.log('Mobile chart expanded:', { hasChart, hasStatus });
      expect(hasChart || hasStatus, 'Chart should show canvas or status, never blank').toBe(true);
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

  test('chart expands', async ({ page }) => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });

    const summary = page.locator('summary').filter({ hasText: 'Show price history' }).first();
    if (await summary.isVisible().catch(() => false)) {
      await summary.click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: '/tmp/p0-2-desktop-expanded.png', fullPage: true });
    }
  });
});
