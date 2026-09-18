import { defineConfig } from '@playwright/test';

export default defineConfig({
  outputDir: 'test-results/product-pwa',
  testDir: './tests/product-pwa',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    baseURL: 'http://127.0.0.1:4174',
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
  },
  globalSetup: './tests/fixtures/product-pwa-setup.ts',
  reporter: 'list',
});
