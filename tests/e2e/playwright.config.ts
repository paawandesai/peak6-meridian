/**
 * Playwright smoke (M2-13): the app against a local validator with an injected test wallet.
 * `global-setup.ts` starts the validator, seeds it and starts the app; specs run serially in file
 * order (one funded wallet, 1 faucet claim per wallet per 24 h). Run: `pnpm --filter e2e playwright test`
 * (needs a local-oracle build in target/deploy, see `make e2e-ui`).
 */
import { defineConfig } from "@playwright/test";

const APP_PORT = Number(process.env.E2E_APP_PORT ?? "3100");

export default defineConfig({
  testDir: "playwright",
  testMatch: "**/*.spec.ts",
  globalSetup: "./playwright/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Cold `next dev` compiles and a loaded 1-vCPU runner are slow; a trade is several round trips.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI
    ? [["list"], ["junit", { outputFile: "playwright-report/junit.xml" }]]
    : "list",
  outputDir: "playwright-report/artifacts",
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
