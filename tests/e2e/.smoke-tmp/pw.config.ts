import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "nine-smoke.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: "list",
  use: {
    baseURL: "https://meridian-nine.vercel.app",
    trace: "on",
    screenshot: "on",
  },
});
