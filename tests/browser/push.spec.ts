import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function session(page: Page) {
  return (await page.evaluate(() => localStorage.getItem('todo-sync-lab-session')))!;
}
async function control(request: APIRequestContext, id: string, pauseAck: boolean) {
  const response = await request.post('/api/spike/control', {
    headers: { 'x-spike-session': id },
    data: { pauseAck },
  });
  expect(response.ok()).toBe(true);
}
async function state(request: APIRequestContext, id: string) {
  const response = await request.get('/api/spike/state', { headers: { 'x-spike-session': id } });
  expect(response.ok()).toBe(true);
  return response.json();
}
async function create(page: Page, title = 'ACK safety') {
  await page.getByLabel('Neuer Task', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Erstellen' }).click();
  await expect(page.getByRole('status')).toHaveText('Lokal atomar gespeichert');
}
async function change(page: Page) {
  const checkbox = page.getByTestId('task').getByRole('checkbox');
  await checkbox.setChecked(!(await checkbox.isChecked()));
  await expect(page.getByRole('status')).toHaveText('Lokal atomar gespeichert');
}
async function push(page: Page, count: number) {
  await page.getByRole('button', { name: 'Test-Push', exact: true }).click();
  await expect(page.getByTestId('sync-status')).toHaveText(`${count} ACK(s) bestätigt`);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/sync-lab');
  await expect(page.getByRole('status')).toHaveText('Lokal bereit');
});

test('HTTP ACK v5 leaves locally edited v6 pending until its own push', async ({
  page,
  request,
}) => {
  await create(page);
  for (let v = 2; v <= 4; v++) await change(page);
  await push(page, 4);
  await change(page);
  const id = await session(page);
  await control(request, id, true);
  await page.getByRole('button', { name: 'Test-Push', exact: true }).click();
  await expect.poll(async () => (await state(request, id)).waiting).toBe(1);
  expect((await state(request, id)).records[0].version).toBe(5);
  await change(page);
  await expect(page.getByTestId('task')).toContainText('v6');
  await control(request, id, false);
  await expect(page.getByTestId('sync-status')).toHaveText('1 ACK(s) bestätigt');
  await expect(page.getByTestId('outbox-count')).toHaveText('1');
  await expect(page.getByTestId('outbox-entry')).toContainText('v6');
  expect((await state(request, id)).records[0].version).toBe(5);
  await push(page, 1);
  await expect(page.getByTestId('outbox-count')).toHaveText('0');
  expect((await state(request, id)).records[0].version).toBe(6);
});

for (const interruption of ['reload', 'crash'] as const) {
  test(`remote applied but ACK pending: ${interruption} and duplicate push lose no data`, async ({
    page,
    context,
    request,
  }) => {
    await create(page);
    const id = await session(page);
    await control(request, id, true);
    await page.getByRole('button', { name: 'Test-Push', exact: true }).click();
    await expect.poll(async () => (await state(request, id)).waiting).toBe(1);
    const before = await state(request, id);
    expect(before.mutationCount).toBe(1);
    let recovered = page;
    if (interruption === 'crash') {
      const cdp = await context.newCDPSession(page);
      const crashed = page.waitForEvent('crash');
      void cdp.send('Page.crash').catch(() => {});
      await crashed;
      await page.close();
      recovered = await context.newPage();
      await recovered.goto('/sync-lab');
    } else {
      await page.reload();
    }
    await expect(recovered.getByRole('status')).toHaveText('Lokal bereit');
    await expect(recovered.getByTestId('task')).toContainText('ACK safety');
    await expect(recovered.getByTestId('outbox-count')).toHaveText('1');
    await control(request, id, false);
    await push(recovered, 1);
    await expect(recovered.getByTestId('outbox-count')).toHaveText('0');
    const after = await state(request, id);
    expect(after.requests).toHaveLength(2);
    expect(after.requests[0]).toEqual(after.requests[1]);
    expect(after.mutationCount).toBe(1);
    expect(after.records).toHaveLength(1);
  });
}

test('cancel retains durable outbox and retry; lab never creates the product database', async ({
  page,
  request,
}) => {
  await create(page, 'lab only');
  const id = await session(page);
  await control(request, id, true);
  await page.getByRole('button', { name: 'Test-Push', exact: true }).click();
  await expect.poll(async () => (await state(request, id)).waiting).toBe(1);
  await page.getByRole('button', { name: 'Push abbrechen' }).click();
  await expect(page.getByTestId('sync-status')).toContainText('Push fehlgeschlagen');
  await expect(page.getByTestId('outbox-count')).toHaveText('1');
  await control(request, id, false);
  await push(page, 1);
  expect(
    await page.evaluate(async () =>
      (await indexedDB.databases()).some((database) => database.name === 'todo-spike-v1'),
    ),
  ).toBe(false);
});

test('service worker does not cache API responses', async ({ page, context }) => {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const fetchState = () =>
    page.evaluate(async () => {
      try {
        const response = await fetch('/api/spike/state', {
          headers: { 'x-spike-session': localStorage.getItem('todo-sync-lab-session')! },
        });
        return response.ok;
      } catch {
        return false;
      }
    });
  expect(await fetchState()).toBe(true);
  await context.setOffline(true);
  expect(await fetchState()).toBe(false);
});
