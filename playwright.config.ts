import { defineConfig } from '@playwright/test';
export default defineConfig({
  outputDir: 'test-results/lab',
  testDir: './tests/browser',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
  },
  globalSetup: './tests/fixtures/lab-setup.ts',
  reporter: 'list',
});
