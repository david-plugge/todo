import { triggerSync, logout } from './navigation-helpers';
import { expect, test, type Page } from '@playwright/test';
import { backendAddress } from '../fixtures/backend-address';
async function login(page: Page, name: string) {
  await page.goto('/account');
  await page.getByLabel('E-Mail', { exact: true }).fill(`${name}@example.test`);
  await page.getByLabel('Passwort', { exact: true }).fill('test-password-12345!');
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await expect(page.getByTestId('account-local-status')).toHaveText('Lokal bereit');
}
async function create(page: Page, title: string) {
  await page.getByLabel('Neuer Task', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Task erstellen' }).click();
  await expect(page.getByTestId('account-local-status')).toHaveText('Lokal atomar gespeichert');
}
async function synced(page: Page) {
  await expect(page.getByTestId('account-sync-status')).toHaveText('Synchronisiert');
  await expect(page.getByTestId('account-pending')).toHaveText('0');
}

test('two isolated devices: SSE only triggers pull, tasks/lists and tombstones propagate', async ({
  browser,
}) => {
  const a = await browser.newContext({ baseURL: backendAddress() });
  const b = await browser.newContext({ baseURL: backendAddress() });
  try {
    const first = await a.newPage();
    const second = await b.newPage();
    await login(first, 'ui-owner');
    await login(second, 'ui-owner');
    await first.getByRole('button', { name: /Alle Aufgaben/ }).click();
    await second.getByRole('button', { name: /Alle Aufgaben/ }).click();
    await synced(first);
    await synced(second);
    let release!: () => void;
    let requested!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const pullRequested = new Promise<void>((r) => {
      requested = r;
    });
    await second.route('**/api/todo/pull**', async (route) => {
      requested();
      await gate;
      await route.continue();
    });
    await create(first, 'SSE verified');
    await pullRequested;
    await expect(second.getByTestId('account-task')).toHaveCount(0);
    release();
    await expect(second.getByTestId('account-task')).toContainText('SSE verified');
    await second.unroute('**/api/todo/pull**');
    await first.getByLabel('Neue Liste', { exact: true }).fill('Shared inbox');
    await first.getByLabel('Neue Liste', { exact: true }).press('Enter');
    await expect(second.getByTestId('account-list')).toHaveText('Shared inbox');
    await second.getByTestId('account-task').getByRole('checkbox').click();
    await expect(first.getByTestId('account-task').getByRole('checkbox')).toBeChecked();
    await second.getByRole('button', { name: 'SSE verified bearbeiten', exact: true }).click();
    await second.getByRole('button', { name: 'Löschen', exact: true }).click();
    await expect(first.getByTestId('account-task')).toHaveCount(0);
    await first.reload();
    await expect(first.getByTestId('account-local-status')).toHaveText('Lokal bereit');
    await expect(first.getByTestId('account-task')).toHaveCount(0);
    await synced(first);
    await synced(second);
  } finally {
    await a.close();
    await b.close();
  }
});

test('offline cached login opens immediately, edits survive reload and reconnect; account switch isolates data', async ({
  page,
  context,
}) => {
  await login(page, 'offline');
  await create(page, 'before offline');
  await synced(page);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('account-local-status')).toHaveText('Lokal bereit');
  await create(page, 'offline pending');
  await page.reload();
  await expect(page.getByTestId('account-task')).toHaveCount(2);
  await expect(page.getByTestId('account-pending')).toHaveText('1');
  await context.setOffline(false);
  await triggerSync(page);
  await synced(page);
  await logout(page);
  await login(page, 'ui-other');
  await synced(page);
  await expect(page.getByTestId('account-task')).toHaveCount(0);
  await logout(page);
  await login(page, 'offline');
  await expect(page.getByTestId('account-task')).toHaveCount(2);
});

test('expired token never blocks offline startup or local writes', async ({ page, context }) => {
  await login(page, 'ui-other');
  await synced(page);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('todo-auth-v1')!);
    saved.token = 'expired.invalid.token';
    localStorage.setItem('todo-auth-v1', JSON.stringify(saved));
  });
  await page.reload();
  await expect(page.getByTestId('account-local-status')).toHaveText('Lokal bereit');
  await create(page, 'expired token local');
  await expect(page.getByTestId('account-pending')).toHaveText('1');
});
