/**
 * Seeded smoke spec for meridian-seeded-smoke.sh harness.
 * Tests: /, /trade/<first strike>, /portfolio, /status
 * Viewports: 390x844 (mobile), 1280x800 (desktop)
 *
 * Pass/fail rules:
 * - FAIL on pageerror > 0
 * - FAIL on any NEW distinct console.error message (normalized, not in baseline set)
 * - Report error counts informationally (counts vary due to polling retries)
 *
 * Normalization: strip URLs, chunk hashes ([a-f0-9-]+), line/col numbers
 * Baseline: SMOKE_BASELINE points to .md table; reads .messages.json for message set
 * Writes: $TMP_DIR/smoke-table.md, $TMP_DIR/smoke-messages.json
 */
import { test, expect } from "@playwright/test";
import { writeFileSync, readFileSync, existsSync } from "fs";

const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844 },
  { name: "1280x800", width: 1280, height: 800 },
];

const results: Array<{
  viewport: string;
  route: string;
  pageerrors: number;
  consoleerrors: number;
  top3errors: string[];
  distinctMessages: Set<string>;
}> = [];

function normalizeErrorMessage(msg: string): string {
  // Take only first line to avoid multi-line stack traces
  const firstLine = msg.split('\n')[0].trim();
  return firstLine
    .replace(/https?:\/\/[^\s]+/g, "<URL>") // URLs
    .replace(/\/[a-f0-9-]{8,}/g, "/<HASH>") // chunk hashes in paths
    .replace(/\.[a-f0-9]{8,}\./g, ".<HASH>.") // chunk hashes in filenames
    .replace(/:\d+:\d+/g, ":<LINE>:<COL>") // line:col numbers
    .replace(/\(\d+:\d+\)/g, "(<LINE>:<COL>)") // (line:col) numbers
    .trim();
}

let baselineMessages: Set<string> | null = null;
const baselinePath = process.env.SMOKE_BASELINE;
if (baselinePath && existsSync(baselinePath)) {
  const messagesPath = baselinePath.replace(/\.md$/, ".messages.json");
  if (existsSync(messagesPath)) {
    const data = JSON.parse(readFileSync(messagesPath, "utf-8"));
    // Apply normalizeErrorMessage to baseline entries to match runtime normalization
    baselineMessages = new Set((data.messages || []).map(normalizeErrorMessage));
  }
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name}`, () => {
    test.use({ viewport });

    test("/ (home)", async ({ page }) => {
      const pageerrors: string[] = [];
      const consoleerrors: string[] = [];
      const failedRequests: Array<{url: string, status: number, statusText: string}> = [];
      page.on("pageerror", (e) => pageerrors.push(e.message));
      page.on("console", (m) => { if (m.type() === "error") consoleerrors.push(m.text()); });
      page.on("response", (response) => {
        if (response.status() >= 500) {
          failedRequests.push({
            url: response.url(),
            status: response.status(),
            statusText: response.statusText(),
          });
        }
      });

      await page.goto("/", { waitUntil: "load", timeout: 30000 });

      // P0-1: If test markets are hidden (seeded with --close-in-secs), reveal them
      const testMarketToggle = page.locator('button:has-text("Show test markets")');
      try {
        await testMarketToggle.waitFor({ state: "visible", timeout: 10000 });
        await testMarketToggle.click();
      } catch {
        // No toggle visible: session markets are present, or no markets at all
      }

      // SMOKE_ALLOW_NO_OPEN=1: accept either strike rows OR closed-state text (weekend)
      if (process.env.SMOKE_ALLOW_NO_OPEN === "1") {
        const strikeRow = page.locator('tr:has(a[href*="/trade/"])').first();
        const closedText = page.locator('text=/Trading has stopped|Settlement delayed|No markets/').first();
        try {
          await strikeRow.waitFor({ state: "visible", timeout: 5000 });
        } catch {
          await closedText.waitFor({ state: "visible", timeout: 5000 });
        }
      } else {
        await page.locator('tr:has(a[href*="/trade/"])').first().waitFor({ state: "visible" });
      }

      const distinctMessages = new Set(consoleerrors.map(normalizeErrorMessage));
      const top3 = Array.from(new Set(consoleerrors)).slice(0, 3);

      if (failedRequests.length > 0) {
        console.log(`[${viewport.name} /] Failed requests:`, JSON.stringify(failedRequests, null, 2));
      }

      results.push({
        viewport: viewport.name,
        route: "/",
        pageerrors: pageerrors.length,
        consoleerrors: consoleerrors.length,
        top3errors: top3,
        distinctMessages,
      });

      expect(pageerrors.length, `Page errors on / at ${viewport.name}: ${pageerrors.join(", ")}`).toBe(0);

      if (baselineMessages) {
        const newMessages = Array.from(distinctMessages).filter(m => !baselineMessages!.has(m));
        expect(
          newMessages,
          `New console.error messages on / at ${viewport.name}: ${newMessages.join("; ")}`
        ).toEqual([]);
      }
    });

    test("/trade/<first strike>", async ({ page }) => {
      const pageerrors: string[] = [];
      const consoleerrors: string[] = [];
      page.on("pageerror", (e) => pageerrors.push(e.message));
      page.on("console", (m) => { if (m.type() === "error") consoleerrors.push(m.text()); });

      // SMOKE_TRADE_MARKET=<pubkey>: go directly to trade page (weekend)
      if (process.env.SMOKE_TRADE_MARKET) {
        await page.goto(`/trade/${process.env.SMOKE_TRADE_MARKET}`, { waitUntil: "load", timeout: 30000 });
        // Assert question heading renders
        await page.locator('h1, h2, h3').first().waitFor({ state: "visible", timeout: 10000 });
      } else {
        await page.goto("/", { waitUntil: "load", timeout: 30000 });

        // P0-1: If test markets are hidden, reveal them before clicking first strike
        const testMarketToggle = page.locator('button:has-text("Show test markets")');
        try {
          await testMarketToggle.waitFor({ state: "visible", timeout: 10000 });
          await testMarketToggle.click();
        } catch {
          // No toggle visible: session markets are present
        }

        const firstStrike = page.locator('tr:has(a[href*="/trade/"])').first();
        await firstStrike.waitFor({ state: "visible" });
        await firstStrike.click();
        await page.waitForURL(/\/trade\/.+/, { timeout: 10000 });
      }

      const distinctMessages = new Set(consoleerrors.map(normalizeErrorMessage));
      const top3 = Array.from(new Set(consoleerrors)).slice(0, 3);
      results.push({
        viewport: viewport.name,
        route: "/trade/<strike>",
        pageerrors: pageerrors.length,
        consoleerrors: consoleerrors.length,
        top3errors: top3,
        distinctMessages,
      });

      expect(pageerrors.length, `Page errors on /trade at ${viewport.name}: ${pageerrors.join(", ")}`).toBe(0);

      if (baselineMessages) {
        const newMessages = Array.from(distinctMessages).filter(m => !baselineMessages!.has(m));
        expect(
          newMessages,
          `New console.error messages on /trade at ${viewport.name}: ${newMessages.join("; ")}`
        ).toEqual([]);
      }
    });

    test("/portfolio", async ({ page }) => {
      const pageerrors: string[] = [];
      const consoleerrors: string[] = [];
      page.on("pageerror", (e) => pageerrors.push(e.message));
      page.on("console", (m) => { if (m.type() === "error") consoleerrors.push(m.text()); });

      await page.goto("/portfolio", { waitUntil: "load", timeout: 30000 });

      const distinctMessages = new Set(consoleerrors.map(normalizeErrorMessage));
      const top3 = Array.from(new Set(consoleerrors)).slice(0, 3);
      results.push({
        viewport: viewport.name,
        route: "/portfolio",
        pageerrors: pageerrors.length,
        consoleerrors: consoleerrors.length,
        top3errors: top3,
        distinctMessages,
      });

      expect(pageerrors.length, `Page errors on /portfolio at ${viewport.name}: ${pageerrors.join(", ")}`).toBe(0);

      if (baselineMessages) {
        const newMessages = Array.from(distinctMessages).filter(m => !baselineMessages!.has(m));
        expect(
          newMessages,
          `New console.error messages on /portfolio at ${viewport.name}: ${newMessages.join("; ")}`
        ).toEqual([]);
      }
    });

    test("/status", async ({ page }) => {
      const pageerrors: string[] = [];
      const consoleerrors: string[] = [];
      page.on("pageerror", (e) => pageerrors.push(e.message));
      page.on("console", (m) => { if (m.type() === "error") consoleerrors.push(m.text()); });

      await page.goto("/status", { waitUntil: "load", timeout: 30000 });

      const distinctMessages = new Set(consoleerrors.map(normalizeErrorMessage));
      const top3 = Array.from(new Set(consoleerrors)).slice(0, 3);
      results.push({
        viewport: viewport.name,
        route: "/status",
        pageerrors: pageerrors.length,
        consoleerrors: consoleerrors.length,
        top3errors: top3,
        distinctMessages,
      });

      expect(pageerrors.length, `Page errors on /status at ${viewport.name}: ${pageerrors.join(", ")}`).toBe(0);

      if (baselineMessages) {
        const newMessages = Array.from(distinctMessages).filter(m => !baselineMessages!.has(m));
        expect(
          newMessages,
          `New console.error messages on /status at ${viewport.name}: ${newMessages.join("; ")}`
        ).toEqual([]);
      }
    });
  });
}

test.afterAll(() => {
  const tmpDir = process.env.TMP_DIR || "/tmp";

  // Collect all distinct normalized messages across all runs
  const allMessages = new Set<string>();
  results.forEach(r => r.distinctMessages.forEach(m => allMessages.add(m)));

  // Write messages.json
  writeFileSync(
    `${tmpDir}/smoke-messages.json`,
    JSON.stringify({ messages: Array.from(allMessages).sort() }, null, 2)
  );

  // Write results table
  const table = [
    "| Viewport | Route | Pageerrors | Console errors | Top 3 distinct console.error messages |",
    "|----------|-------|------------|----------------|----------------------------------------|",
    ...results.map(r => {
      const top3 = r.top3errors.length > 0 ? r.top3errors.join("; ") : "(none)";
      return `| ${r.viewport} | ${r.route} | ${r.pageerrors} | ${r.consoleerrors} | ${top3} |`;
    }),
  ].join("\n");

  writeFileSync(`${tmpDir}/smoke-table.md`, table);
  console.log("\nSmoke test results:");
  console.log(table);
});
