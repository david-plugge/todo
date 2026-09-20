import { expect, test, type Page } from '@playwright/test';
import { setDate } from './date-picker-helpers';
import { chooseList } from './list-select-helpers';

async function login(page: Page) {
  await page.goto('/account');
  await page.getByLabel('E-Mail', { exact: true }).fill('task-groups@example.test');
  await page.getByLabel('Passwort', { exact: true }).fill('test-password-12345!');
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await expect(page.getByTestId('account-local-status')).toHaveText('Lokal bereit');
}

async function create(
  page: Page,
  title: string,
  options: { list?: string; planned?: string } = {},
) {
  await page.getByLabel('Neuer Task', { exact: true }).fill(title);
  if (options.planned) await setDate(page, 'Geplant am', options.planned);
  if (options.list) await chooseList(page, 'Liste', options.list);
  else await chooseList(page, 'Liste', 'Ohne Liste');
  await page.getByRole('button', { name: 'Task erstellen', exact: true }).click();
  await expect(page.getByLabel('Neuer Task', { exact: true })).toHaveValue('');
}

async function sidebarCount(button: ReturnType<Page['getByRole']>) {
  const text = await button.textContent();
  const match = text?.match(/(\d+)\s*$/);
  if (!match) throw new Error(`Sidebar count missing from ${text}`);
  return Number(match[1]);
}

test('contextual task views group completed tasks below the composer and restore reopened tasks', async ({
  page,
}) => {
  const suffix = crypto.randomUUID();
  const listName = `Projekt ${suffix}`;
  const openTitle = `Projekt offen ${suffix}`;
  const completedTitle = `Projekt erledigt ${suffix}`;
  const plannedTitle = `Geplant ${suffix}`;
  await login(page);
  const sidebar = page.getByRole('complementary', { name: 'Aufgabenansichten' });
  const views = sidebar.getByRole('navigation', { name: 'Ansichten' }).getByRole('button');
  await expect(page.getByRole('heading', { name: 'Mein Tag', exact: true })).toBeVisible();
  for (const [index, label] of ['Mein Tag', 'Geplant', 'Alle Aufgaben', 'Erledigt'].entries())
    await expect(views.nth(index)).toContainText(label);
  const allButton = sidebar.getByRole('button', { name: /Alle Aufgaben/ });
  const plannedButton = sidebar.getByRole('button', { name: /Geplant/ });
  const doneButton = sidebar.getByRole('button', { name: /Erledigt/ });
  const [allBefore, plannedBefore, doneBefore] = await Promise.all([
    sidebarCount(allButton),
    sidebarCount(plannedButton),
    sidebarCount(doneButton),
  ]);
  await allButton.click();
  await expect(page.getByRole('heading', { name: 'Alle Aufgaben', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Neue Liste', exact: true }).click();

  await page.getByLabel('Name der neuen Liste', { exact: true }).fill(listName);
  await page.getByLabel('Name der neuen Liste', { exact: true }).press('Enter');

  await create(page, openTitle, { list: listName });
  await create(page, completedTitle, { list: listName });
  await create(page, plannedTitle, { planned: '2026-12-01' });

  await page.getByLabel(`${completedTitle} erledigen`, { exact: true }).click();
  const openGroup = page.getByTestId('open-task-group');
  const completedGroup = page.getByTestId('completed-task-group');
  const composer = page.getByTestId('task-composer');
  const completedToggle = page.getByRole('button', {
    name: `Erledigt (${doneBefore + 1})`,
    exact: true,
  });
  await expect(openGroup).toContainText(openTitle);
  await expect(openGroup).toContainText(plannedTitle);
  await expect(completedGroup).toContainText(completedTitle);
  await expect(completedToggle).toHaveAttribute('aria-expanded', 'true');

  const [openBounds, composerBounds, completedBounds] = await Promise.all([
    openGroup.boundingBox(),
    composer.boundingBox(),
    completedGroup.boundingBox(),
  ]);
  expect(openBounds).not.toBeNull();
  expect(composerBounds).not.toBeNull();
  expect(completedBounds).not.toBeNull();
  expect(openBounds!.y).toBeLessThan(composerBounds!.y);
  expect(composerBounds!.y).toBeLessThan(completedBounds!.y);
  await expect(completedGroup.locator('[data-sortable-row]')).toHaveCount(0);

  await expect.poll(() => sidebarCount(allButton)).toBe(allBefore + 3);
  await expect.poll(() => sidebarCount(plannedButton)).toBe(plannedBefore + 1);
  await expect.poll(() => sidebarCount(doneButton)).toBe(doneBefore + 1);
  const [allBounds, plannedBounds, doneBounds] = await Promise.all([
    allButton.boundingBox(),
    plannedButton.boundingBox(),
    doneButton.boundingBox(),
  ]);
  expect(allBounds).not.toBeNull();
  expect(plannedBounds).not.toBeNull();
  expect(doneBounds).not.toBeNull();
  expect(Math.abs(allBounds!.x - plannedBounds!.x)).toBeLessThan(1);
  expect(Math.abs(plannedBounds!.x - doneBounds!.x)).toBeLessThan(1);
  expect(Math.abs(allBounds!.width - plannedBounds!.width)).toBeLessThan(1);
  expect(Math.abs(plannedBounds!.width - doneBounds!.width)).toBeLessThan(1);

  const projectList = sidebar.getByRole('button', { name: listName, exact: true });
  await expect(projectList).toContainText('1');
  await projectList.click();
  await expect(page.getByRole('heading', { name: listName, exact: true })).toBeVisible();
  await expect(openGroup).toContainText(openTitle);
  await expect(openGroup).not.toContainText(plannedTitle);
  await expect(completedGroup).toContainText(completedTitle);

  await completedGroup.getByLabel(`${completedTitle} wieder öffnen`, { exact: true }).click();
  await expect(openGroup).toContainText(openTitle);
  await expect(openGroup).toContainText(completedTitle);
  await expect(page.getByTestId('completed-task-group')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Erledigt \(0\)/ })).toHaveCount(0);
  await expect(projectList).toContainText('2');

  await doneButton.click();
  await expect(page.getByRole('heading', { name: 'Erledigt', exact: true })).toBeVisible();
  await expect(page.getByTestId('done-task-group')).toHaveCount(1);
  await expect(page.getByTestId('completed-task-group')).toHaveCount(0);
  await expect(page.getByTestId('done-task-group').locator('[data-sortable-row]')).toHaveCount(0);
  await expect(page.getByLabel('Neuer Task', { exact: true })).toHaveCount(0);
  await expect(doneButton).toHaveAttribute('aria-current', 'page');
});
