import { triggerSync } from './navigation-helpers';
import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { initialVersions, taskFields, stampChanges } from '../../src/lib/domain/versions';
import type { Task } from '../../src/lib/domain/models';
import { bootstrapSyncGeneration, syncHeaders } from './sync-api';
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
async function rename(page: Page, currentTitle: string, title: string) {
  await page.getByRole('button', { name: `${currentTitle} bearbeiten`, exact: true }).click();
  await page.getByLabel('Titel bearbeiten').fill(title);
  await page.getByLabel('Titel bearbeiten').press('Tab');
  await expect(
    page
      .getByTestId('account-task')
      .filter({ has: page.getByLabel('Titel bearbeiten', { exact: true }) }),
  ).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Details schließen', exact: true }).click();
  await expect(page.getByTestId('account-local-status')).toHaveText('Lokal atomar gespeichert');
}
async function snapshot(page: Page): Promise<Task[]> {
  return page.evaluate(async () => {
    const { record } = JSON.parse(localStorage.getItem('todo-auth-v1')!);
    return new Promise<Task[]>((resolve, reject) => {
      const open = indexedDB.open(`todo-account-${record.id}`);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('tasks');
        const rows = tx.objectStore('tasks').getAll();
        rows.onsuccess = () => resolve(rows.result);
        tx.oncomplete = () => db.close();
      };
    });
  });
}

for (const kind of ['different', 'same', 'delete'])
  for (const order of ['ab', 'ba']) {
    test(`offline ${kind}-field conflict converges in ${order} order, including reload and server equality`, async ({
      browser,
      request,
    }) => {
      const name = `${kind}-${order}`;
      const contexts = await Promise.all(
        devices.map(() => browser.newContext({ baseURL: 'http://127.0.0.1:8091' })),
      );
      try {
        for (let i = 0; i < 2; i++)
          await contexts[i].addInitScript(
            (device) => localStorage.setItem('todo-device-id', device),
            devices[i],
          );
        const pages = await Promise.all(contexts.map((c) => c.newPage()));
        for (const page of pages) {
          await login(page, name);
          await page.getByRole('button', { name: /Alle Aufgaben/ }).click();
          await synced(page);
        }
        await pages[0].getByLabel('Neuer Task', { exact: true }).fill('base');
        await pages[0].getByRole('button', { name: 'Task erstellen' }).click();
        for (const page of pages) {
          await expect(page.getByTestId('account-task')).toContainText('base');
          await synced(page);
          await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
          await expect
            .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
            .toBe(true);
        }
        for (const context of contexts) await context.setOffline(true);
        await rename(pages[0], 'base', 'title A');
        if (kind === 'same') await rename(pages[1], 'base', 'title B');
        else if (kind === 'different')
          await pages[1].getByTestId('account-task').getByRole('checkbox').click();
        else {
          await pages[1].getByRole('button', { name: 'base bearbeiten', exact: true }).click();
          await pages[1].getByRole('button', { name: 'Löschen', exact: true }).click();
        }
        for (const page of pages) {
          await expect(page.getByTestId('account-pending')).toHaveText('1');
          await page.reload();
          await expect(page.getByTestId('account-local-status')).toHaveText('Lokal bereit');
          await page.getByRole('button', { name: /Alle Aufgaben/ }).click();
          await expect(page.getByTestId('account-pending')).toHaveText('1');
        }
        for (const index of order === 'ab' ? [0, 1] : [1, 0]) {
          await contexts[index].setOffline(false);
          await triggerSync(pages[index]);
          await synced(pages[index]);
        }
        const auth = await (
          await request.post('/api/collections/todo_users/auth-with-password', {
            data: { identity: `${name}@example.test`, password: 'test-password-12345!' },
          })
        ).json();
        const records = await (
          await request.get('/api/collections/tasks/records', {
            headers: { Authorization: auth.token },
          })
        ).json();
        expect(records.items).toHaveLength(1);
        const server = records.items[0].data;
        expect(server.title).toBe(kind === 'same' ? 'title B' : 'title A');
        expect(server.completed).toBe(kind === 'different');
        if (kind === 'delete') expect(server.deletedAt).toBeGreaterThan(0);
        for (const page of pages) {
          await triggerSync(page);
          await expect.poll(() => snapshot(page)).toEqual([server]);
          await synced(page);
          await page.reload();
          await expect(page.getByTestId('account-local-status')).toHaveText('Lokal bereit');
          await expect.poll(() => snapshot(page)).toEqual([server]);
          await page.getByRole('button', { name: /Alle Aufgaben/ }).click();
          await expect(page.getByTestId('account-task')).toHaveCount(kind === 'delete' ? 0 : 1);
        }
      } finally {
        for (const context of contexts) await context.close();
      }
    });
  }

async function auth(request: APIRequestContext) {
  const result = await (
    await request.post('/api/collections/todo_users/auth-with-password', {
      data: { identity: 'field-api@example.test', password: 'test-password-12345!' },
    })
  ).json();
  const generation = await bootstrapSyncGeneration(request, result.token);
  return { headers: syncHeaders(result.token, generation), owner: result.record.id };
}
test('field protocol validates stamps, keeps receipts stable, and rejects legacy downgrades', async ({
  request,
}) => {
  const { headers, owner } = await auth(request);
  const payload: Task = {
    id: crypto.randomUUID(),
    ownerId: owner,
    title: 'initial',
    completed: false,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    fieldVersions: initialVersions(taskFields, devices[0]),
  };
  const mutation = {
    id: crypto.randomUUID(),
    entityId: payload.id,
    entityType: 'task',
    entityVersion: 1,
    operation: 'create',
    deviceId: devices[0],
    baseRevision: 0,
    payload,
  };
  const send = (data: unknown) => request.post('/api/todo/push', { headers, data });
  expect((await send({ ...mutation, payload: { ...payload, fieldVersions: {} } })).status()).toBe(
    400,
  );
  const first = await send(mutation);
  expect(first.status()).toBe(200);
  const ack = await first.json();
  const edited = structuredClone(payload);
  stampChanges(edited, ['completed'], devices[1]);
  edited.completed = true;
  expect(
    (
      await send({
        ...mutation,
        id: crypto.randomUUID(),
        deviceId: devices[1],
        entityVersion: edited.version,
        operation: 'update',
        payload: edited,
      })
    ).status(),
  ).toBe(200);
  expect(await (await send(mutation)).json()).toEqual(ack);
  expect(
    (
      await send({
        ...mutation,
        id: crypto.randomUUID(),
        payload: { ...payload, title: 'same-stamp different-value' },
      })
    ).status(),
  ).toBe(409);
  const legacy = { ...payload };
  delete legacy.fieldVersions;
  expect((await send({ ...mutation, id: crypto.randomUUID(), payload: legacy })).status()).toBe(
    409,
  );
  const listId = crypto.randomUUID();
  const list = {
    id: listId,
    ownerId: owner,
    name: 'Inbox',
    version: 1,
    fieldVersions: initialVersions(['name', 'deletedAt'], devices[0]),
  };
  const listMutation = {
    ...mutation,
    id: crypto.randomUUID(),
    entityId: listId,
    entityType: 'list',
    payload: list,
  };
  expect((await send(listMutation)).status()).toBe(200);
  for (const device of [devices[1], devices[0]]) {
    const edit = structuredClone(list);
    stampChanges(edit, ['name'], device);
    edit.name = device === devices[1] ? 'winner' : 'loser';
    expect(
      (
        await send({
          ...listMutation,
          id: crypto.randomUUID(),
          entityVersion: 2,
          deviceId: device,
          operation: 'update',
          payload: edit,
        })
      ).status(),
    ).toBe(200);
  }
  const lists = await (await request.get('/api/collections/lists/records', { headers })).json();
  expect(lists.items[0].data.name).toBe('winner');
});
