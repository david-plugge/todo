import { triggerSync } from './navigation-helpers';
import { setDate } from './date-picker-helpers';
import { expect, test, type Page } from '@playwright/test';
import type { Task } from '../../src/lib/domain/models';
async function login(page: Page, name: string) {
  await page.goto('/account');
  await page.getByLabel('E-Mail', { exact: true }).fill(`${name}@example.test`);
  await page.getByLabel('Passwort', { exact: true }).fill('test-password-12345!');
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await expect(page.getByTestId('account-local-status')).toHaveText('Lokal bereit');
}
async function synced(page: Page) {
  await expect(page.getByTestId('account-sync-status')).toHaveText('Synchronisiert');
  await expect(page.getByTestId('account-pending')).toHaveText('0');
}
async function create(page: Page, title: string) {
  await page.getByLabel('Neuer Task', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Task erstellen', exact: true }).click();
  await expect(page.getByLabel('Neuer Task', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Neuer Task', { exact: true })).toBeEnabled();
}
async function records(page: Page): Promise<Task[]> {
  return page.evaluate(
    () =>
      new Promise<Task[]>((resolve, reject) => {
        const auth = JSON.parse(localStorage.getItem('todo-auth-v1')!);
        const open = indexedDB.open(`todo-account-${auth.record.id}`);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('tasks');
          const read = tx.objectStore('tasks').getAll();
          read.onsuccess = () => resolve(read.result);
          tx.oncomplete = () => db.close();
        };
      }),
  );
}
const task = (page: Page, title: string) =>
  page
    .getByTestId('account-task')
    .filter({ has: page.getByTestId('task-title').filter({ hasText: new RegExp(`^${title}$`) }) });
async function expectDateTriggerPositionToStayPut(page: Page, title: string, label: string) {
  const closedRow = task(page, title);
  const taskId = await closedRow.getAttribute('data-sort-id');
  expect(taskId).not.toBeNull();
  const row = page.locator(`[data-testid="account-task"][data-sort-id="${taskId}"]`);
  const trigger = row.getByLabel(label, { exact: true });
  const closed = (await trigger.boundingBox())!;
  await row.getByTestId('task-title').click();
  const open = (await trigger.boundingBox())!;
  expect(Math.abs(open.x - closed.x)).toBeLessThan(1);
  expect(Math.abs(open.y - closed.y)).toBeLessThan(1);
  await row.getByRole('button', { name: 'Details schließen', exact: true }).click();
}
async function mouseDrag(page: Page, from: string, to: string, end = false, cancel = false) {
  const source = task(page, from);
  await source.scrollIntoViewIfNeeded();
  const start = (await source.boundingBox())!;
  const target = (await task(page, to).boundingBox())!;
  const pendingBefore = await page.getByTestId('account-pending').textContent();
  await page.mouse.move(start.x + start.width - 8, start.y + start.height - 4);
  await page.mouse.down();
  await page.mouse.move(
    target.x + target.width / 2,
    end ? target.y + target.height - 5 : target.y + 5,
    { steps: 12 },
  );
  const clone = page.locator('#dnd-action-dragged-el');
  await expect(clone).toBeVisible();
  await expect
    .poll(async () => {
      const titles = await page
        .getByTestId('account-task')
        .getByTestId('task-title')
        .allTextContents();
      return end
        ? titles.indexOf(from) > titles.indexOf(to)
        : titles.indexOf(from) < titles.indexOf(to);
    })
    .toBe(true);
  await expect(page.getByTestId('account-pending')).toHaveText(pendingBefore!);
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(clone).toHaveCount(0);
  await expect(page.getByLabel('Titel bearbeiten', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('sort-status')).toHaveText(
    cancel ? 'Verschieben abgebrochen.' : 'Neue Reihenfolge gespeichert.',
  );
}

test('task details use an accessible collapsible and keep one controlled editor open', async ({
  page,
}) => {
  await login(page, 'task-collapsible');
  await create(page, 'Alpha');
  await create(page, 'Beta');

  const alphaId = await task(page, 'Alpha').getAttribute('data-sort-id');
  const betaId = await task(page, 'Beta').getAttribute('data-sort-id');
  expect(alphaId).not.toBeNull();
  expect(betaId).not.toBeNull();
  const alpha = page.locator(`article[data-sort-id="${alphaId}"]`);
  const beta = page.locator(`article[data-sort-id="${betaId}"]`);
  const alphaTrigger = alpha.getByRole('button', { name: 'Alpha bearbeiten', exact: true });
  await expect(alphaTrigger).toHaveAttribute('aria-expanded', 'false');
  await expect(alphaTrigger).toHaveAttribute('aria-controls', /.+/);
  const contentId = await alphaTrigger.getAttribute('aria-controls');
  expect(contentId).not.toBeNull();
  const alphaContent = page.locator(`#${contentId}`);
  await expect(alphaContent).toBeHidden();

  await alphaTrigger.focus();
  await alphaTrigger.press('Enter');
  await expect(alphaContent).toBeVisible();
  await expect(alpha.getByLabel('Titel bearbeiten', { exact: true })).toBeFocused();

  await alpha.getByRole('button', { name: 'Details schließen', exact: true }).click();
  await expect(alphaTrigger).toBeFocused();
  await expect(alphaTrigger).toHaveAttribute('aria-expanded', 'false');
  await expect(alphaContent).toBeHidden();

  await alphaTrigger.press('Space');
  await expect(alpha.getByLabel('Titel bearbeiten', { exact: true })).toBeFocused();
  await alpha.getByRole('button', { name: 'Wiederholung hinzufügen', exact: true }).click();
  await expect(page.getByTestId('recurrence-popover')).toBeVisible();

  const betaTrigger = beta.getByRole('button', { name: 'Beta bearbeiten', exact: true });
  await page.keyboard.press('Escape');
  await betaTrigger.click();
  await expect(page.getByLabel('Titel bearbeiten', { exact: true })).toHaveCount(1);
  await expect(beta.getByLabel('Titel bearbeiten', { exact: true })).toBeFocused();
  await expect(alphaTrigger).not.toBeFocused();
  await expect(page.getByTestId('recurrence-popover')).toBeHidden();

  await beta.getByRole('button', { name: 'Details schließen', exact: true }).click();
  await expect(beta.getByRole('button', { name: 'Beta bearbeiten', exact: true })).toBeFocused();
  await alpha.click({ position: { x: 3, y: 3 } });
  await expect(alpha.getByLabel('Titel bearbeiten', { exact: true })).toBeFocused();
});

test('offline autosave: title blur plus checkbox, date changes, list selection and clearing persist without Save', async ({
  page,
  context,
}) => {
  await login(page, 'live-edit');
  await page.getByRole('button', { name: /Alle Aufgaben/ }).click();
  await page.getByLabel('Neuer Task', { exact: true }).fill('Discard this draft');
  await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  await expect(page.getByLabel('Neuer Task', { exact: true })).toHaveValue('');
  await expect(page.getByTestId('task-composer-footer')).toBeHidden();
  await expect(page.getByTestId('account-task')).toHaveCount(0);

  await page.getByRole('button', { name: 'Neue Liste', exact: true }).click();

  await page.getByLabel('Name der neuen Liste', { exact: true }).fill('Inbox');
  await page.getByLabel('Name der neuen Liste', { exact: true }).press('Enter');
  await create(page, 'Original');
  await synced(page);
  const originalId = (await records(page)).find((item) => item.title === 'Original')!.id;
  const original = async () => (await records(page)).find((item) => item.id === originalId)!;
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.getByTestId('task-title').click();
  await expect(page.getByRole('button', { name: 'Speichern', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('field-save-status')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Nach oben', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Löschen', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Details schließen', exact: true })).toBeVisible();
  await page.getByLabel('Titel bearbeiten', { exact: true }).fill('Direct edit');
  // One tap blurs the title and commits completion; neither event may swallow the other.
  await page.getByTestId('account-task').getByRole('checkbox').click();
  await expect.poll(original).toMatchObject({ title: 'Direct edit', completed: true });
  await setDate(page, 'Geplant am bearbeiten', '2026-11-02');
  await setDate(page, 'Fällig am bearbeiten', '2026-11-03');
  await page.getByLabel('Liste bearbeiten', { exact: true }).selectOption({ label: 'Inbox' });
  await expect.poll(original).toMatchObject({
    plannedDate: '2026-11-02',
    dueDate: '2026-11-03',
    listId: expect.any(String),
  });
  await page.getByRole('button', { name: 'Details schließen', exact: true }).click();
  await expectDateTriggerPositionToStayPut(page, 'Direct edit', 'Geplant am bearbeiten');
  await expectDateTriggerPositionToStayPut(page, 'Direct edit', 'Fällig am bearbeiten');
  await create(page, 'Due only');
  await task(page, 'Due only').getByTestId('task-title').click();
  await setDate(page, 'Fällig am bearbeiten', '2026-11-04');
  await page.getByRole('button', { name: 'Details schließen', exact: true }).click();
  await expectDateTriggerPositionToStayPut(page, 'Due only', 'Fällig am bearbeiten');
  await page.setViewportSize({ width: 320, height: 740 });
  await expectDateTriggerPositionToStayPut(page, 'Due only', 'Fällig am bearbeiten');
  await task(page, 'Direct edit').getByTestId('task-title').click();
  await expect(
    page
      .getByTestId('account-task')
      .filter({ has: page.getByLabel('Titel bearbeiten', { exact: true }) }),
  ).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Details schließen', exact: true }).click();
  await task(page, 'Direct edit').click({ position: { x: 3, y: 3 } });
  await expect(page.getByLabel('Titel bearbeiten', { exact: true })).toBeVisible();
  const footer = page
    .getByTestId('account-task')
    .filter({ has: page.getByLabel('Titel bearbeiten', { exact: true }) })
    .getByTestId('task-editor-footer');
  const listBox = (await footer.getByLabel('Liste bearbeiten').locator('..').boundingBox())!;
  const buttonsBox = (await footer.getByTestId('task-footer-actions').boundingBox())!;
  expect(
    Math.abs(listBox.y + listBox.height / 2 - buttonsBox.y - buttonsBox.height / 2),
  ).toBeLessThan(2);
  expect(buttonsBox.x + buttonsBox.width).toBeLessThanOrEqual(320);
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.reload();
  await expect(page.getByTestId('account-local-status')).toHaveText('Lokal bereit');
  await page.getByRole('button', { name: /Alle Aufgaben/ }).click();
  expect(await original()).toMatchObject({
    title: 'Direct edit',
    completed: true,
    plannedDate: '2026-11-02',
    dueDate: '2026-11-03',
  });
  await task(page, 'Direct edit').getByTestId('task-title').click();
  await setDate(page, 'Fällig am bearbeiten', null);
  await expect.poll(async () => (await original()).dueDate).toBeNull();
  await page.getByLabel('Titel bearbeiten', { exact: true }).fill('');
  await page.getByLabel('Titel bearbeiten', { exact: true }).press('Tab');
  await expect(page.getByTestId('field-save-status')).toHaveText('Bitte einen Titel eingeben.');
  expect((await original()).title).toBe('Direct edit');
  await page.getByLabel('Titel bearbeiten', { exact: true }).fill('Valid again');
  await page.getByLabel('Titel bearbeiten', { exact: true }).press('Enter');
  await expect.poll(async () => (await original()).title).toBe('Valid again');
  await context.setOffline(false);
  await triggerSync(page);
  await synced(page);
});

test('mouse drag commits only at drop, cancels with Escape, and persists offline reload; rows support keyboard', async ({
  page,
  context,
}) => {
  await login(page, 'pointer-drag');
  for (const title of ['A', 'B', 'C']) await create(page, title);
  await task(page, 'A').getByTestId('task-title').click();
  await page.getByLabel('Titel bearbeiten', { exact: true }).fill('A saved on switch');
  await task(page, 'B').getByTestId('task-title').click();
  await expect(page.getByLabel('Titel bearbeiten', { exact: true })).toHaveCount(1);
  await expect(page.getByLabel('Titel bearbeiten', { exact: true })).toHaveValue('B');
  await expect
    .poll(
      async () => (await records(page)).find((item) => item.title === 'A saved on switch')?.title,
    )
    .toBe('A saved on switch');
  await task(page, 'A saved on switch').getByTestId('task-title').click();
  await page.getByLabel('Titel bearbeiten', { exact: true }).fill('A');
  await page.getByLabel('Neuer Task', { exact: true }).fill('Unfinished draft');
  await expect(page.getByLabel('Titel bearbeiten', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('task-composer-footer')).toBeVisible();
  await task(page, 'B').getByTestId('task-title').click();
  await expect(page.getByTestId('task-composer-footer')).toBeHidden();
  await expect(page.getByLabel('Neuer Task', { exact: true })).toHaveValue('Unfinished draft');
  await page.getByLabel('Neuer Task', { exact: true }).click();
  await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  await task(page, 'B').getByTestId('task-title').click();
  await page.getByRole('button', { name: 'Mein Tag', exact: false }).click();
  await page.getByRole('button', { name: 'Alle Aufgaben', exact: false }).click();
  await expect(page.getByLabel('Titel bearbeiten', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('task-composer-footer')).toBeHidden();

  const closedTitle = (await task(page, 'C').getByTestId('task-title').boundingBox())!;
  await task(page, 'C').getByTestId('task-title').click();
  const input = page.getByLabel('Titel bearbeiten', { exact: true });
  const inlineTitle = (await input.boundingBox())!;
  expect(Math.abs(inlineTitle.y - closedTitle.y)).toBeLessThan(3);
  expect(Math.abs(inlineTitle.x - closedTitle.x)).toBeLessThan(1);
  await input.fill('Discard this draft');
  await input.press('Escape');
  await expect(input).toHaveValue('C');
  const expanded = page
    .getByTestId('account-task')
    .filter({ has: page.getByLabel('Titel bearbeiten', { exact: true }) });
  const start = (await expanded.boundingBox())!;
  const destination = (await task(page, 'A').boundingBox())!;
  await page.mouse.move(start.x + start.width - 8, start.y + 12);
  await page.mouse.down();
  await page.mouse.move(destination.x + destination.width - 8, destination.y + 5, { steps: 12 });
  const ghost = page.locator('#dnd-action-dragged-el');
  await expect(ghost).toBeVisible();
  await expect(ghost.getByLabel('Titel bearbeiten', { exact: true })).toHaveCount(0);
  await expect(ghost.getByTestId('task-title')).toHaveText('C');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.getByLabel('Titel bearbeiten', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('task-title')).toHaveText(['A', 'B', 'C']);
  await synced(page);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await mouseDrag(page, 'C', 'A', false, true);
  await expect(page.getByTestId('task-title')).toHaveText(['A', 'B', 'C']);
  await expect(page.getByTestId('account-pending')).toHaveText('0');
  // A release outside the list must not create an outbox entry.
  const handle = task(page, 'C');
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width - 8, box.y + box.height - 4);
  await page.mouse.down();
  await page.mouse.move(5, box.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('sort-status')).toHaveText('Reihenfolge unverändert.');
  await expect(page.getByTestId('account-pending')).toHaveText('0');
  await mouseDrag(page, 'C', 'A');
  await expect(page.getByTestId('task-title')).toHaveText(['C', 'A', 'B']);
  await page.reload();
  await expect(page.getByTestId('task-title')).toHaveText(['C', 'A', 'B']);
  const keyboardRow = task(page, 'C').locator('..');
  await keyboardRow.press('Space');
  await keyboardRow.press('ArrowDown');
  await expect(page.getByTestId('task-title')).toHaveText(['A', 'C', 'B']);
  await keyboardRow.press('ArrowDown');
  await keyboardRow.press('Space');
  await expect(page.getByTestId('task-title')).toHaveText(['A', 'B', 'C']);
  await expect(page.getByLabel('Neuer Task', { exact: true })).toBeEnabled();
  await context.setOffline(false);
  await triggerSync(page);
  await synced(page);
});

test('real touch pointer drag at mobile width reorders tasks and lists without arrows', async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL: 'http://127.0.0.1:8091',
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    const page = await context.newPage();
    await login(page, 'touch-drag');
    await page.getByRole('button', { name: 'Mehr', exact: true }).click();
    for (const name of ['First list', 'Second list']) {
      await page.getByRole('button', { name: 'Neue Liste', exact: true }).click();
      await page.getByLabel('Name der neuen Liste', { exact: true }).fill(name);
      await page.getByLabel('Name der neuen Liste', { exact: true }).press('Enter');
      await expect(page.getByLabel('Name der neuen Liste', { exact: true })).toHaveCount(0);
    }
    const session = await context.newCDPSession(page);
    async function touch(from: { x: number; y: number }, to: { x: number; y: number }) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ ...from, id: 1 }],
      });
      // A hold starts a drag; an immediate swipe remains native scrolling.
      await page.waitForTimeout(220);
      await expect(page.locator('#dnd-action-dragged-el')).toBeVisible();
      for (let step = 1; step <= 8; step++)
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [
            {
              x: from.x + ((to.x - from.x) * step) / 8,
              y: from.y + ((to.y - from.y) * step) / 8,
              id: 1,
            },
          ],
        });
      await page.waitForTimeout(250);
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(page.getByTestId('sort-status')).toHaveText('Neue Reihenfolge gespeichert.');
    }
    const listGrip = page.getByRole('button', {
      name: 'Second list',
      exact: true,
    });
    await listGrip.scrollIntoViewIfNeeded();
    const source = (await listGrip.boundingBox())!;
    const target = (await page
      .getByRole('button', { name: 'First list', exact: true })
      .boundingBox())!;
    await touch(
      { x: source.x + source.width / 2, y: source.y + source.height / 2 },
      { x: target.x + target.width / 2, y: target.y + 4 },
    );
    await expect(page.getByTestId('account-list')).toHaveText(['Second list', 'First list']);
    await page.getByRole('button', { name: 'Menü schließen' }).click();
    for (const title of ['One', 'Two']) await create(page, title);
    await synced(page);
    const grip = task(page, 'Two');
    await grip.scrollIntoViewIfNeeded();
    const from = (await grip.boundingBox())!;
    const to = (await task(page, 'One').boundingBox())!;
    await touch(
      { x: from.x + from.width - 8, y: from.y + from.height - 4 },
      { x: to.x + to.width / 2, y: to.y + 4 },
    );
    await expect(page.getByTestId('task-title')).toHaveText(['Two', 'One']);
    await expect(page.getByRole('button', { name: 'Nach oben', exact: true })).toHaveCount(0);
    await synced(page);
    await page.reload();
    await expect(page.getByTestId('task-title')).toHaveText(['Two', 'One']);
    // Enough content to exercise native scrolling with bottom navigation.
    for (let index = 0; index < 16; index++) await create(page, `Weitere Aufgabe ${index + 1}`);
    await synced(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    // A swipe on the row scrolls; it must not change task order or open details.
    await task(page, 'One').getByTestId('task-title').scrollIntoViewIfNeeded();
    const swipeBox = (await task(page, 'One').getByTestId('task-title').boundingBox())!;
    const swipeStart = {
      x: swipeBox.x + swipeBox.width / 2,
      y: swipeBox.y + swipeBox.height / 2,
      id: 1,
    };
    const scrollBefore = await page.evaluate(() => scrollY);
    const snapshot = await records(page);
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [swipeStart],
    });
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ ...swipeStart, y: swipeStart.y - 60 }],
    });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(scrollBefore);
    await expect(page.locator('#dnd-action-dragged-el')).toHaveCount(0);
    expect(await records(page)).toEqual(snapshot);
    await expect(page.getByLabel('Titel bearbeiten', { exact: true })).toHaveCount(0);

    // OS gesture cancellation must clean up the floating row without saving.
    const cancelRow = task(page, 'One');
    await cancelRow.scrollIntoViewIfNeeded();
    const cancelBox = (await cancelRow.boundingBox())!;
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        { x: cancelBox.x + cancelBox.width - 8, y: cancelBox.y + cancelBox.height - 4, id: 1 },
      ],
    });
    await page.waitForTimeout(220);
    await expect(page.locator('#dnd-action-dragged-el')).toBeVisible();
    await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await expect(page.locator('#dnd-action-dragged-el')).toHaveCount(0);
    await expect(page.getByTestId('sort-status')).toHaveText('Verschieben abgebrochen.');
    expect(await records(page)).toEqual(snapshot);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
  } finally {
    await context.close();
  }
});

test('dropping a task on a sidebar list assigns it only on release and survives offline reload', async ({
  page,
  context,
}) => {
  await login(page, 'list-drop');
  await page.getByRole('button', { name: /Alle Aufgaben/ }).click();
  await create(page, 'Move me');
  for (const name of ['Source list', 'Target list']) {
    await page.getByRole('button', { name: 'Neue Liste', exact: true }).click();
    await page.getByLabel('Name der neuen Liste', { exact: true }).fill(name);
    await page.getByLabel('Name der neuen Liste', { exact: true }).press('Enter');
    await expect(page.getByLabel('Name der neuen Liste', { exact: true })).toHaveCount(0);
  }
  await synced(page);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  const destination = page.getByRole('button', { name: 'Target list', exact: true });
  const listId = await destination.getAttribute('data-task-drop-list');
  async function dragToList(cancel: boolean) {
    const grip = task(page, 'Move me');
    await grip.scrollIntoViewIfNeeded();
    const from = (await grip.boundingBox())!;
    const to = (await destination.boundingBox())!;
    await page.mouse.move(from.x + from.width - 8, from.y + 12);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await expect(page.locator('[data-testid="list-drop-target"][data-active="true"]')).toHaveCount(
      1,
    );
    const clone = page.locator('#dnd-action-dragged-el');
    await expect(clone).toBeVisible();
    await expect(clone).toHaveClass(/compact-drag/);
    await expect(clone.locator('.compact-drag-title')).toHaveText('Move me');
    await expect(clone.getByTestId('account-task')).toBeHidden();
    await expect.poll(async () => (await clone.boundingBox())!.width).toBeLessThanOrEqual(220);
    const floating = (await clone.boundingBox())!;
    expect(floating.x).toBeLessThan(from.x);
    expect(Math.abs(floating.y - to.y)).toBeLessThan(from.height + to.height);
    expect((await records(page))[0].listId).not.toBe(listId);
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(page.locator('[data-testid="list-drop-target"][data-active="true"]')).toHaveCount(
      0,
    );
    await expect(page.locator('#dnd-action-dragged-el')).toHaveCount(0);
  }
  await dragToList(true);
  await expect(page.getByTestId('account-pending')).toHaveText('0');
  await dragToList(false);
  await expect.poll(async () => (await records(page))[0].listId).toBe(listId);
  await expect(task(page, 'Move me').getByTestId('task-list-label')).toHaveText('Target list');
  const titleBox = (await task(page, 'Move me').getByTestId('task-title').boundingBox())!;
  const labelBox = (await task(page, 'Move me').getByTestId('task-list-label').boundingBox())!;
  expect(Math.abs(labelBox.x - titleBox.x)).toBeLessThanOrEqual(6);
  await page.reload();
  await page.getByRole('button', { name: 'Target list', exact: true }).click();
  await expect(page.getByTestId('task-title')).toHaveText(['Move me']);
  await expect(page.getByTestId('task-list-label')).toHaveCount(0);
  const sourceList = page.getByRole('button', { name: 'Source list', exact: true });
  const sourceId = await sourceList.getAttribute('data-task-drop-list');
  await task(page, 'Move me').locator('..').press('Space');
  await page.getByRole('list', { name: 'Nach Source list verschieben', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await records(page))[0].listId).toBe(sourceId);
  await expect(page.getByTestId('account-task')).toHaveCount(0);
  await sourceList.click();
  await expect(page.getByTestId('task-title')).toHaveText(['Move me']);
  await context.setOffline(false);
  await triggerSync(page);
  await synced(page);
});

test('task notes render as sanitized markdown and survive a reload', async ({ page }) => {
  await login(page, 'task-notes');
  await create(page, 'Steuer');
  await synced(page);
  const row = page.getByTestId('account-task').filter({ hasText: 'Steuer' });
  await row.getByRole('button', { name: 'Steuer bearbeiten', exact: true }).click();
  await row.getByRole('button', { name: 'Beschreibung hinzufügen', exact: true }).click();
  const note = row.getByLabel('Beschreibung bearbeiten', { exact: true });
  await note.fill('Belege **sammeln**\n\n- Lohnsteuer\n\n<img src=x onerror="alert(1)">');
  await note.blur();

  const rendered = row.getByTestId('task-note');
  await expect(rendered.locator('strong')).toHaveText('sammeln');
  await expect(rendered.locator('li')).toHaveText('Lohnsteuer');
  await expect(rendered.locator('img')).toHaveCount(0);
  await synced(page);

  await page.reload();
  await expect(page.getByTestId('account-local-status')).toHaveText('Lokal bereit');
  const reloaded = page.getByTestId('account-task').filter({ hasText: 'Steuer' });
  await reloaded.getByRole('button', { name: 'Steuer bearbeiten', exact: true }).click();
  await expect(reloaded.getByTestId('task-note').locator('strong')).toHaveText('sammeln');

  // Clearing the note brings the placeholder back.
  await reloaded.getByTestId('task-note').click();
  await reloaded.getByLabel('Beschreibung bearbeiten', { exact: true }).fill('');
  await reloaded.getByLabel('Beschreibung bearbeiten', { exact: true }).blur();
  await expect(
    reloaded.getByRole('button', { name: 'Beschreibung hinzufügen', exact: true }),
  ).toBeVisible();
});
