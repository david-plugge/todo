import { defineConfig } from '@playwright/test';
export default defineConfig({
  outputDir: 'test-results/pocketbase',
  testDir: './tests/pocketbase',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    baseURL: 'http://127.0.0.1:8091',
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
  },
  globalSetup: './tests/fixtures/pocketbase-setup.ts',
  reporter: 'list',
});
