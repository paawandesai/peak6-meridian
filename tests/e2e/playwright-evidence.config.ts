/**
 * Playwright config for M2-06 evidence collection (03-trade-evidence.spec.ts).
 * Runs manually via `pnpm test:evidence`, not in CI or default `test:ui`.
 */
import { defineConfig } from "@playwright/test";

const APP_PORT = Number(process.env.E2E_APP_PORT ?? "3100");

export default defineConfig({
  testDir: "playwright",
  testMatch: "**/03-trade-evidence.spec.ts",
  globalSetup: "./playwright/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: "list",
  outputDir: "playwright-report/evidence",
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    trace: "on",
    screenshot: "on",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
