import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    outboxReached?: boolean;
  }
}

async function crash(page: import('@playwright/test').Page) {
  const session = await page.context().newCDPSession(page);
  const crashed = page.waitForEvent('crash');
  void session.send('Page.crash').catch(() => {});
  await crashed;
}

test('committed offline task and outbox survive a renderer crash', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('Lokal bereit');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.getByLabel('Neuer Task', { exact: true }).fill('crash durable');
  await page.getByRole('button', { name: 'Erstellen' }).click();
  await expect(page.getByRole('status')).toHaveText('Lokal atomar gespeichert');
  await crash(page);
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto('/');
  await expect(reopened.getByTestId('task')).toContainText('crash durable');
  await expect(reopened.getByTestId('outbox-count')).toHaveText('1');
});

test('renderer crash between task request success and outbox write aborts the transaction', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('Lokal bereit');
  // The outbox write is stalled instead of paused: a renderer halted in the
  // debugger stops processing Page.crash, so the kill would never arrive. A
  // request that keeps looping holds the transaction open with an idle main
  // thread, which is the state the crash has to hit.
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args: Parameters<typeof add>) {
      // The adapter awaits task.add before invoking this second add.
      if (this.name !== 'outbox') return add.apply(this, args);
      const keepAlive = () => {
        const pending = this.get('crash-keep-alive');
        pending.onsuccess = keepAlive;
        pending.onerror = keepAlive;
        return pending;
      };
      window.outboxReached = true;
      // The adapter must never see this settle: a resolved add would let the
      // transaction commit the task it is supposed to roll back.
      return new Proxy(keepAlive(), {
        set: (target, property, value) =>
          property === 'onsuccess' ||
          property === 'onerror' ||
          Reflect.set(target, property, value),
      });
    };
  });
  await page.getByLabel('Neuer Task', { exact: true }).fill('must roll back');
  const click = page
    .getByRole('button', { name: 'Erstellen' })
    .click()
    .catch(() => {});
  await expect.poll(() => page.evaluate(() => window.outboxReached === true)).toBe(true);
  await crash(page);
  await page.close();
  await click;
  const reopened = await context.newPage();
  await reopened.goto('/');
  await expect(reopened.getByRole('status')).toHaveText('Lokal bereit');
  await expect(reopened.getByTestId('task')).toHaveCount(0);
  await expect(reopened.getByTestId('outbox-count')).toHaveText('0');
});
