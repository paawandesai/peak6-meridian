import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "..",
  testMatch: "nine-smoke.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 60000,
  reporter: "line",
});
