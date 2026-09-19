import { defineConfig } from '@playwright/test';
export default defineConfig({
  outputDir: 'test-results/pocketbase',
  testDir: './tests/pocketbase',
  // All local browser contexts share one loopback IP. Keep enough parallelism
  // for useful race coverage without turning the production IP limiter into a
  // suite-wide aggregate bottleneck that real clients would not create.
  workers: 2,
  use: {
    trace: 'retain-on-failure',
    // The workspace disables its transitions and flip animations under
    // prefers-reduced-motion, so geometry assertions see settled layouts.
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    // The global setup publishes the address of the backend it started for this run.
    baseURL: process.env.TODO_TEST_ADDRESS,
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
  },
  globalSetup: './tests/fixtures/pocketbase-setup.ts',
  reporter: 'list',
});
