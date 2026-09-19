import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, name: string) {
  await page.goto('/account');
  await page.getByLabel('E-Mail', { exact: true }).fill(`${name}@example.test`);
  await page.getByLabel('Passwort', { exact: true }).fill('test-password-12345!');
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await expect(page.getByTestId('account-local-status')).toHaveText('Lokal bereit');
}

test('renames and deletes a list while keeping its tasks', async ({ page }) => {
  await login(page, 'list-actions');
  await page.getByRole('button', { name: 'Neue Liste', exact: true }).click();
  await page.getByLabel('Name der neuen Liste', { exact: true }).fill('Projekte');
  await page.getByLabel('Name der neuen Liste', { exact: true }).press('Enter');
  await page.getByLabel('Neuer Task', { exact: true }).fill('Bleibt erhalten');
  await page.getByLabel('Liste', { exact: true }).selectOption({ label: 'Projekte' });
  await page.getByRole('button', { name: 'Task erstellen', exact: true }).click();

  await page.getByLabel('Optionen für Projekte', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Umbenennen', exact: true }).click();
  await page.getByLabel('Listenname', { exact: true }).fill('Privat');
  await page.getByLabel('Listenname', { exact: true }).press('Enter');
  await expect(page.getByTestId('account-list')).toHaveText('Privat');

  await page.getByLabel('Optionen für Privat', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Löschen', exact: true }).click();
  await expect(page.getByText(/Aufgaben bleiben erhalten/)).toBeVisible();
  const deleteTasks = page.getByLabel('Aufgaben in dieser Liste ebenfalls löschen', {
    exact: true,
  });
  await expect(deleteTasks).not.toBeChecked();
  await deleteTasks.check();
  await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  await page.getByLabel('Optionen für Privat', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Löschen', exact: true }).click();
  await expect(deleteTasks).not.toBeChecked();
  await page.getByRole('button', { name: 'Liste löschen', exact: true }).click();
  await expect(page.getByTestId('account-list')).toHaveCount(0);
  await expect(page.getByTestId('task-title')).toHaveText('Bleibt erhalten');
  await expect(page.getByText('Liste nicht verfügbar')).toHaveCount(0);
  await expect(page.getByTestId('account-sync-status')).toHaveText('Synchronisiert');
  await page.reload();
  await expect(page.getByTestId('account-local-status')).toHaveText('Lokal bereit');
  await expect(page.getByTestId('account-list')).toHaveCount(0);
  await expect(page.getByTestId('task-title')).toHaveText('Bleibt erhalten');
});

test('deletes active and completed tasks when the list delete option is checked', async ({
  page,
  context,
}) => {
  await login(page, 'list-actions-delete-tasks');
  await page.getByRole('button', { name: 'Neue Liste', exact: true }).click();
  await page.getByLabel('Name der neuen Liste', { exact: true }).fill('Archiv');
  await page.getByLabel('Name der neuen Liste', { exact: true }).press('Enter');
  for (const title of ['Aktiv', 'Erledigt']) {
    await page.getByLabel('Neuer Task', { exact: true }).fill(title);
    await page.getByLabel('Liste', { exact: true }).selectOption({ label: 'Archiv' });
    await page.getByRole('button', { name: 'Task erstellen', exact: true }).click();
    await expect(page.getByLabel('Neuer Task', { exact: true })).toHaveValue('');
    await expect(page.getByTestId('task-title')).toContainText([title]);
  }
  await page.getByLabel('Erledigt erledigen', { exact: true }).click();

  await page.getByLabel('Optionen für Archiv', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Löschen', exact: true }).click();
  const deleteTasks = page.getByLabel('Aufgaben in dieser Liste ebenfalls löschen', {
    exact: true,
  });
  await expect(deleteTasks).not.toBeChecked();
  await deleteTasks.check();
  await expect(
    page.getByText(
      'Die Liste Archiv wird gelöscht. Alle Aufgaben darin werden ebenfalls gelöscht.',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Liste löschen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Liste löschen', exact: true })).toHaveCount(0);

  await expect(page.getByTestId('account-list')).toHaveCount(0);
  await expect(page.getByTestId('task-title')).toHaveCount(0);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.getByTestId('account-local-status')).toHaveText('Lokal bereit');
    await expect(page.getByTestId('task-title')).toHaveCount(0);
  } finally {
    await context.setOffline(false);
  }
});

test('list actions are reachable from the mobile drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'list-actions-mobile');
  await page.getByRole('button', { name: 'Mehr', exact: true }).click();
  await page.getByRole('button', { name: 'Neue Liste', exact: true }).click();
  await page.getByLabel('Name der neuen Liste', { exact: true }).fill('Unterwegs');
  await page.getByLabel('Name der neuen Liste', { exact: true }).press('Enter');
  await page.getByLabel('Optionen für Unterwegs', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Umbenennen', exact: true }).click();
  await page.getByLabel('Listenname', { exact: true }).fill('Erledigungen');
  await page.getByLabel('Listenname', { exact: true }).press('Enter');
  await expect(page.getByTestId('account-list')).toHaveText('Erledigungen');
});

test('inline rename cancels with Escape and saves when focus leaves the name', async ({ page }) => {
  await login(page, 'list-actions-inline');
  await page.getByRole('button', { name: 'Neue Liste', exact: true }).click();
  await page.getByLabel('Name der neuen Liste', { exact: true }).fill('Projekte');
  await page.getByLabel('Name der neuen Liste', { exact: true }).press('Enter');

  await page.getByLabel('Optionen für Projekte', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Umbenennen', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mein Tag', exact: true })).toBeVisible();
  await page.getByLabel('Listenname', { exact: true }).fill('Verwerfen');
  await page.getByLabel('Listenname', { exact: true }).press('Escape');
  await expect(page.getByTestId('account-list')).toHaveText('Projekte');

  await page.getByLabel('Optionen für Projekte', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Umbenennen', exact: true }).click();
  await page.getByLabel('Listenname', { exact: true }).fill('Privat');
  await page.getByRole('button', { name: 'Neue Liste', exact: true }).focus();
  await expect(page.getByTestId('account-list')).toHaveText('Privat');
});
