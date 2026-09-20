import { expect, test, type Page } from '@playwright/test';
import type { Task } from '../../src/lib/domain/models';
import { setDate } from './date-picker-helpers';

async function login(page: Page) {
  await page.goto('/account');
  await page.getByLabel('E-Mail', { exact: true }).fill('recurrence@example.test');
  await page.getByLabel('Passwort', { exact: true }).fill('test-password-12345!');
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await expect(page.getByTestId('account-local-status')).toHaveText('Lokal bereit');
}

async function storedTask(page: Page, id: string): Promise<Task> {
  return page.evaluate(
    (taskId) =>
      new Promise<Task>((resolve, reject) => {
        const auth = JSON.parse(localStorage.getItem('todo-auth-v1')!);
        const open = indexedDB.open(`todo-account-${auth.record.id}`);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('tasks');
          const read = tx.objectStore('tasks').get(taskId);
          read.onsuccess = () => resolve(read.result);
          read.onerror = () => reject(read.error);
          tx.oncomplete = () => db.close();
        };
      }),
    id,
  );
}

test('recurrence drafts apply atomically and completing creates the next open occurrence', async ({
  page,
}) => {
  const suffix = crypto.randomUUID();
  const otherTitle = `Anderes Todo ${suffix}`;
  const recurrenceTitle = `Zweiwoechentlicher Termin ${suffix}`;
  await login(page);
  await page.getByRole('button', { name: /Alle Aufgaben/ }).click();
  const initialTaskCount = await page.getByTestId('account-task').count();
  await page.getByLabel('Neuer Task', { exact: true }).fill(otherTitle);
  await page.getByRole('button', { name: 'Task erstellen', exact: true }).click();
  await expect(page.getByTestId('task-title').filter({ hasText: otherTitle })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Task erstellen', exact: true })).toBeHidden();

  await page.getByLabel('Neuer Task', { exact: true }).fill(recurrenceTitle);
  await setDate(page, 'Geplant am', '2026-09-15');
  await page.getByRole('button', { name: 'Task erstellen', exact: true }).click();
  await expect(page.getByTestId('task-title').filter({ hasText: recurrenceTitle })).toBeVisible();
  await expect(page.getByTestId('account-sync-status')).toHaveText('Synchronisiert');
  await expect(page.getByTestId('account-pending')).toHaveText('0');

  const createdTask = page.getByTestId('account-task').filter({
    has: page.getByTestId('task-title').filter({ hasText: recurrenceTitle }),
  });
  const taskId = await createdTask.getAttribute('data-sort-id');
  expect(taskId).not.toBeNull();
  const persistedBefore = await storedTask(page, taskId!);
  const task = page.locator(`article[data-sort-id="${taskId}"]`);
  const otherTask = page
    .getByTestId('account-task')
    .filter({ has: page.getByTestId('task-title').filter({ hasText: otherTitle }) });
  await task.getByRole('button', { name: `${recurrenceTitle} bearbeiten`, exact: true }).click();
  const plannedDate = task.getByRole('button', {
    name: 'Geplant am bearbeiten',
    exact: true,
  });
  const addRecurrence = task.getByRole('button', {
    name: 'Wiederholung hinzufügen',
    exact: true,
  });
  await expect(plannedDate).toBeVisible();
  await expect(addRecurrence).toBeVisible();
  await addRecurrence.focus();
  await expect(addRecurrence).toBeFocused();
  await addRecurrence.click();

  const recurrencePopover = page.getByTestId('recurrence-popover');
  const editRecurrence = task.getByRole('button', {
    name: 'Wiederholung bearbeiten',
    exact: true,
  });
  await expect(recurrencePopover).toBeVisible();
  await expect(
    recurrencePopover.getByRole('combobox', { name: 'Einheit', exact: true }),
  ).toHaveValue('week');
  await expect(recurrencePopover.getByRole('button', { name: 'Di', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(recurrencePopover.getByText('Nächste Termine', { exact: true })).toHaveCount(0);
  await expect(recurrencePopover.getByText('Expertenmodus: RRULE', { exact: true })).toHaveCount(0);

  const tuesday = recurrencePopover.getByRole('button', { name: 'Di', exact: true });
  const monday = recurrencePopover.getByRole('button', { name: 'Mo', exact: true });
  const apply = recurrencePopover.getByRole('button', { name: 'Übernehmen', exact: true });
  await tuesday.focus();
  await page.keyboard.press('Space');
  await expect(tuesday).toHaveAttribute('aria-pressed', 'false');
  await expect(recurrencePopover.getByText('Wähle mindestens einen Wochentag aus.')).toBeVisible();
  await expect(apply).toBeDisabled();
  await monday.click();
  await expect(monday).toHaveAttribute('aria-pressed', 'true');
  await expect(recurrencePopover.getByText('Wähle mindestens einen Wochentag aus.')).toBeHidden();
  await expect(apply).toBeEnabled();

  const interval = recurrencePopover.getByRole('spinbutton', { name: 'Alle', exact: true });
  await interval.fill('2');
  await expect(recurrencePopover).toBeVisible();

  const unit = recurrencePopover.getByRole('combobox', { name: 'Einheit', exact: true });
  await unit.selectOption('month');
  await expect(recurrencePopover).toBeVisible();
  await recurrencePopover.locator('input[value="weekday"]').check();
  await recurrencePopover.getByRole('combobox', { name: 'Position im Monat' }).selectOption('2');
  await recurrencePopover.getByRole('combobox', { name: 'Wochentag im Monat' }).selectOption('FR');
  await expect(recurrencePopover).toBeVisible();
  await unit.selectOption('week');
  await expect(recurrencePopover).toBeVisible();

  const friday = recurrencePopover.getByRole('button', { name: 'Fr', exact: true });
  await friday.click();
  await expect(recurrencePopover).toBeVisible();
  await expect(friday).toHaveAttribute('aria-pressed', 'true');
  await monday.focus();
  await page.keyboard.press('Space');
  await expect(recurrencePopover).toBeVisible();
  await expect(monday).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Space');
  await expect(monday).toHaveAttribute('aria-pressed', 'true');
  await tuesday.focus();
  await page.keyboard.press('Space');
  await expect(tuesday).toHaveAttribute('aria-pressed', 'true');

  await expect(task).toHaveAttribute('aria-busy', 'false');
  await expect(otherTask).toHaveAttribute('aria-busy', 'false');
  await expect
    .poll(() => storedTask(page, taskId!))
    .toMatchObject({
      version: persistedBefore.version,
      recurrenceRule: persistedBefore.recurrenceRule,
      recurrenceDate: persistedBefore.recurrenceDate,
    });
  await expect(addRecurrence).toBeVisible();
  await expect(editRecurrence).toHaveCount(0);

  await recurrencePopover.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  await expect(recurrencePopover).toBeHidden();
  await expect(addRecurrence).toBeVisible();
  await expect(editRecurrence).toHaveCount(0);
  await expect(task).toHaveAttribute('aria-busy', 'false');
  await expect
    .poll(() => storedTask(page, taskId!))
    .toMatchObject({
      version: persistedBefore.version,
      recurrenceRule: persistedBefore.recurrenceRule,
      recurrenceDate: persistedBefore.recurrenceDate,
    });

  await addRecurrence.click();
  await page.keyboard.press('Escape');
  await expect(recurrencePopover).toBeHidden();
  await expect
    .poll(() => storedTask(page, taskId!))
    .toMatchObject({
      version: persistedBefore.version,
      recurrenceRule: persistedBefore.recurrenceRule,
      recurrenceDate: persistedBefore.recurrenceDate,
    });

  await addRecurrence.click();
  await page.getByRole('heading', { name: 'Alle Aufgaben', exact: true }).click();
  await expect(recurrencePopover).toBeHidden();
  await expect
    .poll(() => storedTask(page, taskId!))
    .toMatchObject({
      version: persistedBefore.version,
      recurrenceRule: persistedBefore.recurrenceRule,
      recurrenceDate: persistedBefore.recurrenceDate,
    });

  // A new draft starts from persisted values, not the cancelled selections.
  await addRecurrence.click();
  await expect(recurrencePopover).toBeVisible();
  await recurrencePopover.getByRole('spinbutton', { name: 'Alle', exact: true }).fill('2');
  await recurrencePopover.getByRole('button', { name: 'Mo', exact: true }).click();
  await recurrencePopover.getByRole('button', { name: 'Übernehmen', exact: true }).click();
  await expect(recurrencePopover).toBeHidden();
  await expect(editRecurrence).toBeVisible();
  await expect(task).toHaveAttribute('aria-busy', 'false');
  await expect(otherTask).toHaveAttribute('aria-busy', 'false');
  await expect
    .poll(() => storedTask(page, taskId!))
    .toMatchObject({
      version: persistedBefore.version + 1,
      recurrenceRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU',
      recurrenceDate: '2026-09-15',
    });
  await expect(page.getByTestId('account-sync-status')).toHaveText('Synchronisiert');

  // The chip remains available when the details are collapsed and opens the
  // persisted rule as an editable draft.
  await task.getByRole('button', { name: 'Details schließen', exact: true }).click();
  await expect(editRecurrence).toBeVisible();
  await editRecurrence.click();
  await expect(recurrencePopover).toBeVisible();
  await expect(
    recurrencePopover.getByRole('spinbutton', { name: 'Alle', exact: true }),
  ).toHaveValue('2');
  await expect(recurrencePopover.getByRole('button', { name: 'Mo', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await recurrencePopover.getByRole('button', { name: 'Fr', exact: true }).click();
  await expect(recurrencePopover).toBeVisible();
  await recurrencePopover.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  await expect(recurrencePopover).toBeHidden();

  await page.getByLabel(`${recurrenceTitle} erledigen`, { exact: true }).click();
  await expect(page.getByTestId('account-task')).toHaveCount(initialTaskCount + 3);
  await expect(task.getByLabel(`${recurrenceTitle} wieder öffnen`, { exact: true })).toBeChecked();
  const successor = page
    .getByTestId('account-task')
    .filter({ has: page.getByRole('checkbox', { checked: false }) })
    .filter({ has: page.getByText(recurrenceTitle, { exact: true }) });
  await expect(successor).toHaveCount(1);
  await expect(successor.getByTestId('task-title')).toHaveText(recurrenceTitle);
  await expect(
    successor.getByRole('button', { name: 'Geplant am bearbeiten', exact: true }),
  ).toHaveAttribute('data-date', '2026-09-28');

  await expect(page.getByTestId('account-sync-status')).toHaveText('Synchronisiert');
  await page.reload();
  await expect(page.getByTestId('account-local-status')).toHaveText('Lokal bereit');
  await page.getByRole('button', { name: /Alle Aufgaben/ }).click();
  await expect(page.getByTestId('account-task')).toHaveCount(initialTaskCount + 3);
  await expect(
    page
      .getByTestId('account-task')
      .filter({ has: page.getByRole('checkbox', { checked: false }) })
      .filter({ has: page.getByText(recurrenceTitle, { exact: true }) }),
  ).toHaveCount(1);
});

test('the composer creates a task with description and recurrence in one step', async ({
  page,
}) => {
  const title = `Composer Wiederholung ${crypto.randomUUID()}`;
  await login(page);
  await page.getByRole('button', { name: /Alle Aufgaben/ }).click();
  await page.getByLabel('Neuer Task', { exact: true }).fill(title);

  const composer = page.getByTestId('task-composer');
  await composer.getByRole('button', { name: 'Beschreibung hinzufügen', exact: true }).click();
  await composer
    .getByLabel('Beschreibung bearbeiten', { exact: true })
    .fill('Agenda **vorbereiten**');
  await composer.getByLabel('Beschreibung bearbeiten', { exact: true }).blur();
  await expect(composer.getByTestId('task-composer-note').getByRole('strong')).toHaveText(
    'vorbereiten',
  );

  await setDate(page, 'Geplant am', '2026-09-15');
  await composer.getByRole('button', { name: 'Wiederholung hinzufügen', exact: true }).click();
  const recurrencePopover = page.getByTestId('recurrence-popover');
  await expect(recurrencePopover).toBeVisible();
  await recurrencePopover.getByRole('spinbutton', { name: 'Alle', exact: true }).fill('2');
  await recurrencePopover.getByRole('button', { name: 'Übernehmen', exact: true }).click();
  await expect(recurrencePopover).toBeHidden();
  await expect(
    composer.getByRole('button', { name: 'Wiederholung bearbeiten', exact: true }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Task erstellen', exact: true }).click();
  const created = page
    .getByTestId('account-task')
    .filter({ has: page.getByTestId('task-title').filter({ hasText: title }) });
  await expect(created).toHaveCount(1);
  const taskId = await created.getAttribute('data-sort-id');
  await expect
    .poll(() => storedTask(page, taskId!))
    .toMatchObject({
      description: 'Agenda **vorbereiten**',
      plannedDate: '2026-09-15',
      recurrenceRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU',
      recurrenceDate: '2026-09-15',
    });

  // The next draft starts empty again.
  await page.getByLabel('Neuer Task', { exact: true }).click();
  await expect(
    composer.getByRole('button', { name: 'Beschreibung hinzufügen', exact: true }),
  ).toBeVisible();
  await expect(
    composer.getByRole('button', { name: 'Wiederholung hinzufügen', exact: true }),
  ).toBeVisible();
});
