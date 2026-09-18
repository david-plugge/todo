import { chromium, expect, test } from '@playwright/test';

test('production build remains installable and opens offline after a browser restart', async ({}, testInfo) => {
  const options = {
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    headless: true,
    baseURL: 'http://127.0.0.1:4174',
  };
  const profile = testInfo.outputPath('browser-profile');
  let context = await chromium.launchPersistentContext(profile, options);
  try {
    const page = await context.newPage();
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: /Raum für das, was wichtig ist\./ }),
    ).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    const cdp = await context.newCDPSession(page);
    const manifest = await cdp.send('Page.getAppManifest');
    expect(manifest.errors).toEqual([]);
    expect(JSON.parse(manifest.data!)).toMatchObject({
      id: '/',
      name: 'Freiraum',
      start_url: '/',
      display: 'standalone',
    });
    await expect
      .poll(async () => (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors)
      .toEqual([]);
    await context.close();
    context = await chromium.launchPersistentContext(profile, options);
    await context.setOffline(true);
    const reopened = await context.newPage();
    await reopened.goto('/');
    await expect(
      reopened.getByRole('heading', { name: /Raum für das, was wichtig ist\./ }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
