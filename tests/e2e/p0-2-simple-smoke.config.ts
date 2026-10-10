import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'p0-2-smoke-standalone.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: 'http://127.0.0.1:3100',
    screenshot: 'on',
    trace: 'retain-on-failure',
  },
  reporter: 'list',
  // NO global setup - app is already running
});
