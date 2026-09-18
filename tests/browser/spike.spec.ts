import { expect, test, type Page } from '@playwright/test';

type Trace = { stores: string[]; mode: string; state: string; successfulTaskWrites: number };
declare global {
  interface Window {
    idbTrace: Trace[];
  }
}

async function createTask(page: Page, title: string) {
  await page.getByLabel('Neuer Task', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Erstellen' }).click();
  await expect(page.getByRole('status')).toHaveText('Lokal atomar gespeichert');
}

async function durable(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('todo-spike-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction(['tasks', 'outbox'], 'readonly');
      const read = (store: string) =>
        new Promise<unknown[]>((resolve, reject) => {
          const request = tx.objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      return { tasks: await read('tasks'), outbox: await read('outbox') };
    } finally {
      db.close();
    }
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.idbTrace = [];
    const traces = new WeakMap<IDBTransaction, Trace>();
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
      const tx = transaction.apply(this, args);
      if (args[1] === 'readwrite') {
        const trace = {
          stores: Array.from(tx.objectStoreNames).sort(),
          mode: tx.mode,
          state: 'active',
          successfulTaskWrites: 0,
        };
        traces.set(tx, trace);
        window.idbTrace.push(trace);
        tx.addEventListener('complete', () => {
          trace.state = 'complete';
        });
        tx.addEventListener('abort', () => {
          trace.state = 'abort';
        });
      }
      return tx;
    };
    for (const method of ['put', 'add'] as const) {
      const original = IDBObjectStore.prototype[method];
      IDBObjectStore.prototype[method] = function (...args: Parameters<typeof original>) {
        const request = original.apply(this, args);
        const trace = traces.get(this.transaction);
        if (this.name === 'tasks' && trace)
          request.addEventListener('success', () => {
            trace.successfulTaskWrites++;
          });
        return request;
      };
    }
  });
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('Lokal bereit');
});

test('one native transaction commits both records; reload restores Svelte live queries', async ({
  page,
}) => {
  await createTask(page, 'atomic');
  expect(await page.evaluate(() => window.idbTrace)).toEqual([
    {
      stores: ['outbox', 'syncMetadata', 'tasks'],
      mode: 'readwrite',
      state: 'complete',
      successfulTaskWrites: 1,
    },
  ]);
  const snapshot = await durable(page);
  expect(snapshot.tasks).toHaveLength(1);
  expect(snapshot.outbox).toHaveLength(1);
  await page.reload();
  await expect(page.getByTestId('task')).toContainText('atomic');
  await expect(page.getByTestId('outbox-count')).toHaveText('1');
});

test('second write fails AFTER task write; native abort and reload restore both collections', async ({
  page,
}) => {
  await createTask(page, 'rollback proof');
  const before = await durable(page);
  await page.evaluate(() => {
    window.idbTrace = [];
  });
  await page.getByLabel('Outbox-Write absichtlich fehlschlagen lassen').check();
  await page.getByTestId('task').getByRole('checkbox').check();
  await expect(page.getByRole('status')).toContainText('Rollback: Absichtlicher Fehler');
  expect(await page.evaluate(() => window.idbTrace)).toEqual([
    {
      stores: ['outbox', 'syncMetadata', 'tasks'],
      mode: 'readwrite',
      state: 'abort',
      successfulTaskWrites: 1,
    },
  ]);
  await expect(page.getByTestId('task').getByRole('checkbox')).not.toBeChecked();
  expect(await durable(page)).toEqual(before);
  await page.reload();
  await expect(page.getByTestId('task').getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByTestId('outbox-count')).toHaveText('1');
  expect(await durable(page)).toEqual(before);
});

test('offline app-shell reload, create, update and outbox survive further reloads', async ({
  page,
  context,
}) => {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Lokal bereit');
  await createTask(page, 'offline durable');
  await page.reload();
  await expect(page.getByTestId('task')).toContainText('offline durable');
  await page.getByTestId('task').getByRole('checkbox').check();
  await expect(page.getByRole('status')).toHaveText('Lokal atomar gespeichert');
  await page.reload();
  await expect(page.getByTestId('task').getByRole('checkbox')).toBeChecked();
  await expect(page.getByTestId('outbox-count')).toHaveText('2');
});

test('two tabs receive live changes and tombstones', async ({ page, context }) => {
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByRole('status')).toHaveText('Lokal bereit');
  await createTask(page, 'shared between tabs');
  await expect(second.getByTestId('task')).toContainText('shared between tabs');
  await second.getByTestId('task').getByRole('checkbox').check();
  await expect(page.getByTestId('task').getByRole('checkbox')).toBeChecked();
  await second.getByRole('button', { name: 'Löschen' }).click();
  await expect(page.getByTestId('task')).toHaveCount(0);
  await expect(page.getByTestId('outbox-count')).toHaveText('3');
  expect((await durable(page)).tasks).toEqual([
    expect.objectContaining({ deletedAt: expect.any(Number), version: 3 }),
  ]);
});
