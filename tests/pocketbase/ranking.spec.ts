import { triggerSync, openSettings } from './navigation-helpers';
import { setDate } from './date-picker-helpers';
import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { compareRank } from '../../src/lib/ranking/rank';
import { stampChanges } from '../../src/lib/domain/versions';
import type { Task } from '../../src/lib/domain/models';
import { bootstrapSyncGeneration, syncHeaders } from './sync-api';
import { backendAddress } from '../fixtures/backend-address';
const devices = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
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
  await page.getByRole('button', { name: 'Task erstellen' }).click();
  await expect(
    page.getByTestId('task-title').filter({ hasText: new RegExp(`^${title}$`) }),
  ).toBeVisible();
  await expect(page.getByLabel('Neuer Task', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Neuer Task', { exact: true })).toBeEnabled();
}
const row = (page: Page, title: string) =>
  page
    .getByTestId('account-task')
    .filter({ has: page.getByTestId('task-title').filter({ hasText: new RegExp(`^${title}$`) }) });
async function localTasks(page: Page): Promise<Task[]> {
  return page.evaluate(async () => {
    const { record } = JSON.parse(localStorage.getItem('todo-auth-v1')!);
    return new Promise<Task[]>((resolve, reject) => {
      const open = indexedDB.open(`todo-account-${record.id}`);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('tasks');
        const read = tx.objectStore('tasks').getAll();
        read.onsuccess = () => resolve(read.result);
        tx.oncomplete = () => db.close();
      };
    });
  });
}
async function auth(request: APIRequestContext, name: string) {
  const response = await request.post('/api/collections/todo_users/auth-with-password', {
    data: { identity: `${name}@example.test`, password: 'test-password-12345!' },
  });
  expect(response.status()).toBe(200);
  const json = await response.json();
  const generation = await bootstrapSyncGeneration(request, json.token);
  return { owner: json.record.id, headers: syncHeaders(json.token, generation) };
}
for (const order of ['ab', 'ba'])
  test(`offline moves plus independent calendar fields converge in ${order} order`, async ({
    browser,
    request,
  }) => {
    const contexts = await Promise.all(
      devices.map((_, index) =>
        browser.newContext({
          baseURL: backendAddress(),
          timezoneId: index === 0 ? 'America/Los_Angeles' : 'Asia/Tokyo',
        }),
      ),
    );
    try {
      for (let i = 0; i < 2; i++)
        await contexts[i].addInitScript(
          (device) => localStorage.setItem('todo-device-id', device),
          devices[i],
        );
      const pages = await Promise.all(contexts.map((c) => c.newPage()));
      for (const page of pages) {
        await login(page, `ranking-${order}`);
        await synced(page);
        await page.getByRole('button', { name: /Alle Aufgaben/ }).click();
      }
      for (const title of ['First', 'Middle', 'Last']) await create(pages[0], title);
      for (const page of pages) {
        await expect(page.getByTestId('task-title')).toHaveText(['First', 'Middle', 'Last']);
        await synced(page);
        await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
        await expect
          .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
          .toBe(true);
      }
      for (const context of contexts) await context.setOffline(true);
      for (const [index, key] of [
        [0, 'ArrowUp'],
        [1, 'ArrowDown'],
      ] as const) {
        const item = row(pages[index], 'Middle').locator('..');
        await item.press('Space');
        await item.press(key);
        await item.press('Space');
      }
      await expect(pages[0].getByTestId('task-title')).toHaveText(['Middle', 'First', 'Last']);
      await expect(pages[1].getByTestId('task-title')).toHaveText(['First', 'Last', 'Middle']);
      for (const [index, field, date] of [
        [0, 'Fällig am bearbeiten', '2026-12-20'],
        [1, 'Geplant am bearbeiten', '2026-12-18'],
      ] as const) {
        await row(pages[index], 'Middle')
          .getByRole('button', { name: 'Middle bearbeiten', exact: true })
          .click();
        await setDate(pages[index], field, date);
        await expect(
          pages[index]
            .getByTestId('account-task')
            .filter({ has: pages[index].getByLabel('Titel bearbeiten', { exact: true }) }),
        ).toHaveAttribute('aria-busy', 'false');
        await pages[index].getByRole('button', { name: 'Details schließen', exact: true }).click();
        await expect(pages[index].getByLabel('Titel bearbeiten', { exact: true })).toHaveCount(0);
        await expect(pages[index].getByTestId('account-pending')).toHaveText('2');
        await pages[index].reload();
        await expect(pages[index].getByTestId('account-local-status')).toHaveText('Lokal bereit');
        await expect(pages[index].getByTestId('account-pending')).toHaveText('2');
        await pages[index].getByRole('button', { name: /Alle Aufgaben/ }).click();
      }
      for (const index of order === 'ab' ? [0, 1] : [1, 0]) {
        await contexts[index].setOffline(false);
        await triggerSync(pages[index]);
        await synced(pages[index]);
      }
      const { headers } = await auth(request, `ranking-${order}`);
      const records = await (
        await request.get('/api/collections/tasks/records', { headers })
      ).json();
      const server: Task[] = records.items.map((r: { data: Task }) => r.data).sort(compareRank);
      expect(server.map((task) => task.title)).toEqual(['First', 'Last', 'Middle']);
      expect(server[2]).toMatchObject({ dueDate: '2026-12-20', plannedDate: '2026-12-18' });
      for (const page of pages) {
        await triggerSync(page);
        await expect.poll(async () => (await localTasks(page)).sort(compareRank)).toEqual(server);
        await expect(page.getByTestId('task-title')).toHaveText(['First', 'Last', 'Middle']);
        await page.reload();
        await page.getByRole('button', { name: /Alle Aufgaben/ }).click();
        await expect.poll(async () => (await localTasks(page)).sort(compareRank)).toEqual(server);
      }
      // Clearing is a versioned value; a late duplicate must not restore the old date.
      await row(pages[0], 'Middle')
        .getByRole('button', { name: 'Middle bearbeiten', exact: true })
        .click();
      await setDate(pages[0], 'Fällig am bearbeiten', null);
      await pages[0].getByLabel('Titel bearbeiten', { exact: true }).press('Tab');
      await expect(
        pages[0]
          .getByTestId('account-task')
          .filter({ has: pages[0].getByLabel('Titel bearbeiten', { exact: true }) }),
      ).toHaveAttribute('aria-busy', 'false');
      await pages[0].getByRole('button', { name: 'Details schließen', exact: true }).click();
      await synced(pages[0]);
      await expect
        .poll(
          async () => (await localTasks(pages[1])).find((task) => task.title === 'Middle')?.dueDate,
        )
        .toBeNull();
      // Keeping an editor open must not restamp fields changed remotely in the meantime.
      await row(pages[0], 'Middle')
        .getByRole('button', { name: 'Middle bearbeiten', exact: true })
        .click();
      await row(pages[1], 'Middle')
        .getByRole('button', { name: 'Middle bearbeiten', exact: true })
        .click();
      await setDate(pages[1], 'Geplant am bearbeiten', '2026-12-19');
      await expect(
        pages[1]
          .getByTestId('account-task')
          .filter({ has: pages[1].getByLabel('Titel bearbeiten', { exact: true }) }),
      ).toHaveAttribute('aria-busy', 'false');
      await pages[1].getByRole('button', { name: 'Details schließen', exact: true }).click();
      await synced(pages[1]);
      await expect
        .poll(
          async () =>
            (await localTasks(pages[0])).find((task) => task.title === 'Middle')?.plannedDate,
        )
        .toBe('2026-12-19');
      await pages[0].getByLabel('Titel bearbeiten', { exact: true }).fill('Renamed');
      await pages[0].getByLabel('Titel bearbeiten', { exact: true }).press('Tab');
      await expect(
        pages[0]
          .getByTestId('account-task')
          .filter({ has: pages[0].getByLabel('Titel bearbeiten', { exact: true }) }),
      ).toHaveAttribute('aria-busy', 'false');
      await pages[0].getByRole('button', { name: 'Details schließen', exact: true }).click();
      await synced(pages[0]);
      await expect
        .poll(
          async () =>
            (await localTasks(pages[1])).find((task) => task.title === 'Renamed')?.plannedDate,
        )
        .toBe('2026-12-19');
    } finally {
      for (const context of contexts) await context.close();
    }
  });

test('API validates dates/ranks and safely merges queued Spike-7 snapshots after schema extension', async ({
  request,
}) => {
  const { owner, headers } = await auth(request, 'ranking-api');
  const id = crypto.randomUUID();
  const old: Task = {
    id,
    ownerId: owner,
    title: 'old app',
    completed: false,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    fieldVersions: {
      title: { counter: 1, deviceId: devices[0] },
      completed: { counter: 1, deviceId: devices[0] },
      deletedAt: { counter: 0, deviceId: '' },
    },
  };
  const mutation = {
    id: crypto.randomUUID(),
    entityId: id,
    entityType: 'task',
    entityVersion: 1,
    operation: 'create',
    deviceId: devices[0],
    baseRevision: 0,
    payload: old,
  };
  const send = (data: unknown) => request.post('/api/todo/push', { headers, data });
  const initial = await send(mutation);
  expect(initial.status()).toBe(200);
  const ack = await initial.json();
  const next = structuredClone(old);
  stampChanges(next, ['dueDate', 'plannedDate', 'rank'], devices[1]);
  next.dueDate = '2028-02-29';
  next.plannedDate = '2028-02-20';
  next.rank = '8'.repeat(32);
  const edit = {
    ...mutation,
    id: crypto.randomUUID(),
    entityVersion: next.version,
    operation: 'update',
    deviceId: devices[1],
    payload: next,
  };
  for (const bad of [
    { dueDate: '2027-02-29' },
    { plannedDate: '2026-02-30' },
    { dueDate: '2026-01-01T00:00:00Z' },
    { rank: 'wrong' },
    { rank: '0'.repeat(32) },
    { rank: 'f'.repeat(32) },
  ])
    expect((await send({ ...edit, payload: { ...next, ...bad } })).status()).toBe(400);
  expect((await send(edit)).status()).toBe(200);
  const late = structuredClone(old);
  late.title = 'old client title';
  late.version = 2;
  late.fieldVersions!.title = { counter: 2, deviceId: devices[0] };
  expect(
    (
      await send({
        ...mutation,
        id: crypto.randomUUID(),
        entityVersion: 2,
        operation: 'update',
        payload: late,
      })
    ).status(),
  ).toBe(200);
  expect(await (await send(mutation)).json()).toEqual(ack);
  const records = await (await request.get('/api/collections/tasks/records', { headers })).json();
  expect(records.items[0].data).toMatchObject({
    title: 'old client title',
    dueDate: '2028-02-29',
    plannedDate: '2028-02-20',
    rank: '8'.repeat(32),
  });
});

test('mobile layout: create dated task in list, filter and reorder lists', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'mobile-ui');
  await synced(page);
  const mobileNavigation = page.getByRole('navigation', { name: 'Hauptnavigation' });
  for (const [index, label] of ['Mein Tag', 'Geplant', 'Alle Aufgaben', 'Mehr'].entries())
    await expect(mobileNavigation.getByRole('button').nth(index)).toHaveText(label);
  await expect(page.getByRole('heading', { name: 'Mein Tag', exact: true })).toBeVisible();
  const more = page.getByRole('button', { name: 'Mehr', exact: true });
  await page.evaluate(() => {
    const trigger = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Mehr',
    );
    trigger?.addEventListener(
      'click',
      () => {
        const observer = new MutationObserver(() => {
          const input = document.querySelector<HTMLInputElement>('[aria-label="Neue Liste"]');
          if (!input) return;
          input.disabled = true;
          observer.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
      },
      { capture: true, once: true },
    );
  });
  await more.click();
  const newList = page.getByLabel('Neue Liste', { exact: true });
  const closeDrawer = page.getByRole('button', { name: 'Menü schließen', exact: true });
  await expect(newList).toBeDisabled();
  await expect(closeDrawer).toBeFocused();
  await newList.evaluate((input) => {
    if (!(input instanceof HTMLInputElement)) throw new Error('New-list control is not an input');
    input.disabled = false;
    input.focus();
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(newList).toBeFocused();
  await closeDrawer.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await more.click();
  await expect(newList).toBeFocused();
  await newList.fill('Privat');
  await newList.press('Enter');
  await newList.fill('Arbeit');
  await newList.press('Enter');
  await expect(newList).toHaveValue('');
  await synced(page);
  const drawer = page.getByRole('dialog');
  const listRow = drawer.getByRole('listitem', { name: 'Arbeit', exact: true });
  await listRow.press('Space');
  await listRow.press('ArrowUp');
  await expect(drawer.getByTestId('account-list')).toHaveText(['Arbeit', 'Privat']);
  await listRow.press('Space');
  await expect(page.getByTestId('sort-status')).toHaveText('Neue Reihenfolge gespeichert.');
  await page.getByRole('button', { name: 'Menü schließen' }).click();
  await page.getByRole('button', { name: 'Geplant', exact: true }).click();
  await page.getByLabel('Neuer Task', { exact: true }).click();
  await setDate(page, 'Geplant am', '2026-12-01');
  await setDate(page, 'Fällig am', '2026-12-02');
  await page.getByLabel('Liste', { exact: true }).selectOption({ label: 'Privat' });
  await create(page, 'Termin planen');
  await synced(page);
  await expect(row(page, 'Termin planen').getByLabel('Geplant am bearbeiten')).toHaveAttribute(
    'data-date',
    '2026-12-01',
  );
  await expect(row(page, 'Termin planen').getByLabel('Fällig am bearbeiten')).toHaveAttribute(
    'data-date',
    '2026-12-02',
  );
  await page.getByRole('button', { name: 'Mehr', exact: true }).click();
  await page.getByRole('button', { name: 'Privat', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Privat', exact: true })).toBeVisible();
  await expect(page.getByTestId('account-task')).toHaveCount(1);
  await page.getByRole('button', { name: 'Mehr', exact: true }).click();
  await page.getByRole('button', { name: 'Arbeit', exact: true }).click();
  await expect(page.getByTestId('account-task')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await openSettings(page);
  await expect(page).toHaveURL(/view=settings/);
  await expect(page.getByRole('heading', { name: 'Einstellungen', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Verbundene Agenten' })).toBeVisible();
  await expect(page.getByText('Keine aktiven Verbindungen.')).toBeVisible();
  await expect(page.getByTestId('account-sync-status')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Abmelden', exact: true })).toBeVisible();
  await expect(page.locator('dd').filter({ hasText: 'mobile-ui@example.test' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Einstellungen', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mehr', exact: true }).click();
  await page.getByRole('button', { name: 'Privat', exact: true }).click();
  await expect(page).not.toHaveURL(/view=settings/);
  await expect(page).toHaveTitle('Todo · Deine Aufgaben');
  await expect(page.getByTestId('task-title')).toHaveText('Termin planen');
  await expect(page.locator('main > header, main > footer')).toHaveCount(0);
  await expect(page.getByTestId('account-sync-status')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Abmelden', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Mein Tag', exact: true }).click();
  await create(page, 'Nur heute sichtbar');
  await expect(page.locator('[aria-label="Aufgaben"] .subtitle')).toHaveCount(0);
  await expect(page.getByTestId('task-title')).toHaveText('Nur heute sichtbar');
  const bottom = (await page.getByRole('navigation', { name: 'Hauptnavigation' }).boundingBox())!;
  expect(bottom.y + bottom.height).toBe(page.viewportSize()!.height);
  expect(bottom.height).toBeLessThan(90);
  await page.getByRole('button', { name: 'Mehr', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mehr', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Mehr', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Erledigt \d+$/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Erledigt', exact: true })).toBeVisible();
  await expect(page.getByLabel('Neuer Task', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Alle Aufgaben', exact: true }).click();
  await expect(page.getByLabel('Neuer Task', { exact: true })).toBeVisible();
  await page.getByLabel('Neuer Task', { exact: true }).fill('Ohne Termin');
  await page.getByLabel('Liste', { exact: true }).selectOption('');
  await create(page, 'Ohne Termin');
  const dated = row(page, 'Termin planen');
  const plain = row(page, 'Ohne Termin');
  const plainBounds = (await plain.boundingBox())!;
  const datedBounds = (await dated.boundingBox())!;
  expect(plainBounds.height).toBeLessThanOrEqual(50);
  expect(datedBounds.height).toBeGreaterThan(plainBounds.height);
  expect(datedBounds.height).toBeLessThanOrEqual(76);
  const titleBounds = (await dated.getByTestId('task-title').boundingBox())!;
  const dateBounds = (await dated.getByLabel('Geplant am bearbeiten').boundingBox())!;
  expect(dateBounds.y).toBeGreaterThanOrEqual(titleBounds.y + titleBounds.height);
});

test('server converges when a multi-record rebalance races an offline move in either delivery order', async ({
  request,
}) => {
  const { owner, headers } = await auth(request, 'ranking-api');
  for (const order of ['rebalance-first', 'move-first']) {
    const originals: Task[] = [];
    const send = async (payload: Task, deviceId: string) => {
      const response = await request.post('/api/todo/push', {
        headers,
        data: {
          id: crypto.randomUUID(),
          entityId: payload.id,
          entityType: 'task',
          entityVersion: payload.version,
          operation: payload.version === 1 ? 'create' : 'update',
          deviceId,
          baseRevision: 0,
          payload,
        },
      });
      expect(response.status()).toBe(200);
    };
    for (const [index, title] of ['A', 'B', 'C'].entries()) {
      const payload: Task = {
        id: crypto.randomUUID(),
        ownerId: owner,
        title,
        completed: false,
        version: 1,
        createdAt: 1,
        updatedAt: 1,
        rank: ['4', '8', 'c'][index].repeat(32),
        fieldVersions: {
          title: { counter: 1, deviceId: devices[0] },
          completed: { counter: 1, deviceId: devices[0] },
          deletedAt: { counter: 0, deviceId: '' },
          rank: { counter: 1, deviceId: devices[0] },
        },
      };
      originals.push(payload);
      await send(payload, devices[0]);
    }
    const rebalance = originals.map((record, index) => {
      const copy = structuredClone(record);
      stampChanges(copy, ['rank'], devices[0]);
      copy.rank = ['3', '6', '9'][index].repeat(32);
      return copy;
    });
    const moved = structuredClone(originals[1]);
    stampChanges(moved, ['rank'], devices[1]);
    moved.rank = '2'.repeat(32);
    if (order === 'move-first') await send(moved, devices[1]);
    for (const record of rebalance) await send(record, devices[0]);
    if (order === 'rebalance-first') await send(moved, devices[1]);
    const records = await (
      await request.get('/api/collections/tasks/records?perPage=100', { headers })
    ).json();
    const ids = originals.map((record) => record.id);
    const group: Task[] = records.items
      .map((r: { data: Task }) => r.data)
      .filter((r: Task) => ids.includes(r.id));
    expect(group.sort(compareRank).map((record) => record.title)).toEqual(['B', 'A', 'C']);
    expect(group[0].fieldVersions!.rank.deviceId).toBe(devices[1]);
  }
});
