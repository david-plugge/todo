import { expect, type Page } from '@playwright/test';

export async function openSettings(page: Page) {
  if (page.url().includes('view=settings')) return;
  const more = page.getByRole('button', { name: 'Mehr', exact: true });
  if (await more.isVisible()) await more.click();
  await page.getByRole('link', { name: 'Einstellungen', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Einstellungen', exact: true })).toBeVisible();
}

export async function triggerSync(page: Page) {
  await openSettings(page);
  const button = page.getByRole('button', { name: 'Jetzt synchronisieren', exact: true });
  await button.click();
  // The click only schedules engine.trigger(). Observe the complete cycle before leaving
  // settings so an old "Synchronisiert" state cannot satisfy the next assertion early.
  await expect(button).toBeDisabled();
  await expect(button).toBeEnabled();
  await expect(page.getByTestId('account-sync-status')).toHaveText('Synchronisiert');
  await page.getByRole('link', { name: 'Zurück zu Aufgaben', exact: true }).click();
  await expect(page).not.toHaveURL(/view=settings/);
}

export async function logout(page: Page) {
  await openSettings(page);
  await page.getByRole('button', { name: 'Abmelden', exact: true }).click();
  await page.goto('/account');
}
