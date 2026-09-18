import { afterEach, describe, expect, it } from 'vitest';
import { Dexie } from 'dexie';
import { createStore } from './store';
import { TodoDatabase } from './database';

const stores: ReturnType<typeof createStore>[] = [];
async function open(name: string = crypto.randomUUID()) {
  const store = createStore(name);
  stores.push(store);
  await store.ready;
  return store;
}
afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.close();
    await store.db.delete();
  }
});

describe('Spike 1–3: real TanStack transactions → Dexie → IndexedDB', () => {
  it('commits tasks and outbox in one native transaction and rehydrates', async () => {
    const store = await open();
    const transactions: IDBTransaction[] = [];
    const scopes: string[][] = [];
    const capture = () => {
      const tx = Dexie.currentTransaction!;
      transactions.push(tx.idbtrans);
      scopes.push([...tx.storeNames]);
    };
    store.db.tasks.hook('creating', capture);
    store.db.outbox.hook('creating', capture);
    const id = await store.createTask('durable');
    expect(transactions).toHaveLength(2);
    expect(transactions[0]).toBe(transactions[1]);
    expect(scopes[0].sort()).toEqual(['outbox', 'syncMetadata', 'tasks']);
    expect(store.tasks.get(id)?.title).toBe('durable');
    await store.close();
    const reopened = await open(store.db.name);
    expect(reopened.tasks.get(id)?.title).toBe('durable');
    expect([...reopened.outbox.values()]).toMatchObject([{ entityId: id, entityVersion: 1 }]);
  });

  it('rolls back an already executed task update when second write throws; reopen proves durability', async () => {
    const store = await open();
    const id = await store.createTask('before');
    const baseline = await store.db.outbox.toArray();
    let taskWritten = false;
    let native: IDBTransaction | undefined;
    store.db.tasks.hook('updating', function () {
      native = Dexie.currentTransaction!.idbtrans;
      this.onsuccess = () => {
        taskWritten = true;
      };
    });
    store.db.outbox.hook('creating', () => {
      expect(taskWritten).toBe(true);
      expect(Dexie.currentTransaction!.idbtrans).toBe(native);
      throw new Error('second write fails');
    });
    await expect(store.changeTask(id, { title: 'must disappear' })).rejects.toThrow(
      'second write fails',
    );
    expect(store.tasks.get(id)?.title).toBe('before');
    expect([...store.outbox.values()]).toMatchObject(baseline);
    expect(store.outbox.size).toBe(baseline.length);
    await store.close();
    const reopened = await open(store.db.name);
    expect(reopened.tasks.get(id)).toMatchObject({ title: 'before', version: 1 });
    expect(await reopened.db.outbox.toArray()).toEqual(baseline);
    expect(await reopened.db.syncMetadata.get('adapter-revision')).toMatchObject({ revision: 1 });
  });

  it('rolls back task insert on a native IndexedDB ConstraintError in outbox', async () => {
    const store = await open();
    await store.createTask('existing');
    const existing = [...store.outbox.values()][0];
    // A different collection instance has not observed this key yet.
    const other = await open();
    await other.db.outbox.add(existing);
    await expect(
      other.transact(() => {
        other.tasks.insert({
          id: 'new',
          title: 'rollback',
          completed: false,
          version: 1,
          createdAt: 0,
          updatedAt: 0,
        });
        other.outbox.insert(existing);
      }),
    ).rejects.toMatchObject({ name: 'ConstraintError' });
    expect(await other.db.tasks.get('new')).toBeUndefined();
    expect(await other.db.outbox.count()).toBe(1);
  });

  it('supports mixed insert/update/delete across three collections', async () => {
    const store = await open();
    const id = await store.createTask('old');
    const entry = [...store.outbox.values()][0];
    await store.transact(() => {
      store.tasks.update(id, (task) => {
        task.title = 'new';
      });
      store.lists.insert({ id: 'list', name: 'Inbox', version: 1 });
      store.outbox.delete(entry.id);
    });
    expect(await store.db.tasks.get(id)).toMatchObject({ title: 'new' });
    expect(await store.db.lists.count()).toBe(1);
    expect(await store.db.outbox.count()).toBe(0);
    await store.transact(() => {
      store.lists.delete('list');
    });
    expect(await store.db.lists.count()).toBe(0);
  });

  it('propagates commits into a second connection and keeps tombstones', async () => {
    const first = await open();
    const second = await open(first.db.name);
    const id = await first.createTask('shared');
    await expect.poll(() => second.tasks.get(id)?.title).toBe('shared');
    await second.changeTask(id, { deletedAt: 123 });
    await expect.poll(() => first.tasks.get(id)?.deletedAt).toBe(123);
    expect(await first.db.tasks.count()).toBe(1);
    expect(await first.db.outbox.count()).toBe(2);
  });

  it('rejects stale updates rather than overwriting another tab', async () => {
    const store = await open();
    const id = await store.createTask('base');
    const competing = new TodoDatabase(store.db.name);
    await competing.tasks.update(id, { title: 'newer external value' });
    await expect(store.changeTask(id, { completed: true })).rejects.toThrow('Stale local write');
    expect(await store.db.tasks.get(id)).toMatchObject({
      title: 'newer external value',
      completed: false,
    });
    expect(await store.db.outbox.count()).toBe(1);
    competing.close();
  });

  it('rejects implicit writes that would bypass the transactional outbox', async () => {
    const store = await open();
    expect(() => store.lists.insert({ id: 'x', name: 'unsafe', version: 1 })).toThrow();
    expect(await store.db.lists.count()).toBe(0);
  });
});
