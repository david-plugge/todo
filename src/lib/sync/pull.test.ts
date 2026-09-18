import { afterEach, expect, it } from 'vitest';
import { Dexie } from 'dexie';
import { createStore } from '../db/store';
import { PushWorker } from './push';
import { stampChanges } from '../domain/versions';
import { PullWorker, type PullPage, type RemoteChange } from './pull';
const stores: ReturnType<typeof createStore>[] = [];
async function open(name: string = crypto.randomUUID()) {
  const store = createStore(name, { ownerId: 'owner', deviceId: 'device' });
  stores.push(store);
  await store.ready;
  return store;
}
afterEach(async () => {
  const all = stores.splice(0);
  for (const store of all) await store.close();
  for (const name of new Set(all.map((s) => s.db.name))) await Dexie.delete(name);
});
function change(revision: number, id = 'remote'): RemoteChange {
  return {
    revision,
    entityId: id,
    entityType: 'task',
    payload: {
      id,
      ownerId: 'owner',
      remoteRevision: revision,
      version: revision,
      title: `remote v${revision}`,
      completed: false,
      createdAt: 1,
      updatedAt: revision,
    },
  };
}
function page(changes: RemoteChange[], cursor: number, hasMore = false, until = cursor): PullPage {
  return { changes, cursor, hasMore, until };
}

it('persists records and cursor together, rehydrates and continues without re-reading history', async () => {
  const store = await open();
  const calls: number[] = [];
  await new PullWorker(
    store.adapter,
    {
      fetchPage: async (after, until) => {
        expect(Dexie.currentTransaction).toBeNull();
        calls.push(after);
        if (!after) {
          expect(until).toBeUndefined();
          return page([change(1)], 1, true, 2);
        }
        expect(until).toBe(2);
        return page([change(2, 'second')], 2);
      },
    },
    'owner',
    1,
  ).pull();
  expect(calls).toEqual([0, 1]);
  expect(store.tasks.size).toBe(2);
  await store.close();
  const reopened = await open(store.db.name);
  await new PullWorker(
    reopened.adapter,
    {
      fetchPage: async (after) => {
        expect(after).toBe(2);
        return page([], 2);
      },
    },
    'owner',
  ).pull();
  expect(reopened.tasks.size).toBe(2);
});

it('failed local cursor write rolls back the remote record too', async () => {
  const store = await open();
  store.db.syncMetadata.hook('creating', (_key, value) => {
    if (value.id === 'pull-cursor') throw new Error('cursor write failed');
  });
  await expect(
    new PullWorker(store.adapter, { fetchPage: async () => page([change(1)], 1) }, 'owner').pull(),
  ).rejects.toThrow('cursor write failed');
  expect(await store.db.tasks.count()).toBe(0);
  expect(await store.db.syncMetadata.get('pull-cursor')).toBeUndefined();
});

it('pending edits are never overwritten; deferred remote data survives reload and drains after ACK', async () => {
  const store = await open();
  const id = await store.createTask('local pending');
  await new PullWorker(
    store.adapter,
    { fetchPage: async () => page([change(10, id), change(11, 'unrelated')], 11) },
    'owner',
  ).pull();
  expect(store.tasks.get(id)?.title).toBe('local pending');
  expect(store.tasks.get('unrelated')?.title).toBe('remote v11');
  expect((await store.db.syncMetadata.get('pull-cursor'))?.cursor).toBe(11);
  await store.close();
  const reopened = await open(store.db.name);
  await reopened.adapter.write(['outbox'], async () => {
    await reopened.db.outbox.clear();
  });
  await new PullWorker(reopened.adapter, { fetchPage: async () => page([], 11) }, 'owner').pull();
  expect(reopened.tasks.get(id)?.title).toBe('remote v10');
  expect(await reopened.db.syncMetadata.get(`remote:task:${id}`)).toBeUndefined();
});

it('does not replace a newer local remote snapshot with older replayed history', async () => {
  const store = await open();
  await store.adapter.write(['tasks'], async () => {
    await store.db.tasks.put(change(10).payload as import('../domain/models').Task);
  });
  await new PullWorker(
    store.adapter,
    { fetchPage: async () => page([change(1)], 1) },
    'owner',
  ).pull();
  expect(store.tasks.get('remote')?.remoteRevision).toBe(10);
});

it('invalid owner, duplicate sequence and non-progressing pages cannot advance cursor', async () => {
  const store = await open();
  const foreign = change(1);
  foreign.payload.ownerId = 'someone-else';
  for (const response of [
    page([foreign], 1),
    page([change(1), change(1)], 1),
    page([], 0, true, 2),
  ]) {
    await expect(
      new PullWorker(store.adapter, { fetchPage: async () => response }, 'owner').pull(),
    ).rejects.toThrow();
    expect(await store.db.tasks.count()).toBe(0);
    expect(await store.db.syncMetadata.get('pull-cursor')).toBeUndefined();
  }
});

it('two tab pulls cannot move the shared cursor backwards', async () => {
  const first = await open();
  const second = await open(first.db.name);
  let release!: (p: PullPage) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const stale = new PullWorker(
    first.adapter,
    {
      fetchPage: () => {
        entered();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
    'owner',
  ).pull();
  await started;
  await new PullWorker(
    second.adapter,
    { fetchPage: async () => page([change(2)], 2) },
    'owner',
  ).pull();
  release(page([change(1)], 1));
  await stale;
  expect((await first.db.syncMetadata.get('pull-cursor'))?.cursor).toBe(2);
  expect(await first.db.tasks.get('remote')).toMatchObject({ remoteRevision: 2 });
});

it('ACK pins the current snapshot ahead of older deferred data even if the next pull fails', async () => {
  const store = await open();
  const id = await store.createTask('initial');
  await store.changeTask(id, { title: 'acknowledged newest' });
  const older = change(11, id);
  older.payload.version = 1;
  await new PullWorker(store.adapter, { fetchPage: async () => page([older], 11) }, 'owner').pull();
  await new PushWorker(store.adapter, {
    send: async (m) => ({
      mutationId: m.id,
      entityId: m.entityId,
      entityType: m.entityType,
      entityVersion: m.entityVersion,
      serverRevision: 10 + m.entityVersion,
    }),
  }).push();
  expect(await store.db.outbox.count()).toBe(0);
  await expect(
    new PullWorker(
      store.adapter,
      {
        fetchPage: async () => {
          throw new Error('offline again');
        },
      },
      'owner',
    ).pull(),
  ).rejects.toThrow('offline again');
  expect(await store.db.tasks.get(id)).toMatchObject({
    title: 'acknowledged newest',
    version: 2,
    remoteRevision: 0,
  });
  expect(await store.db.syncMetadata.get(`ack:task:${id}`)).toMatchObject({ revision: 12 });
  const merged = change(12, id);
  (merged.payload as import('../domain/models').Task).title = 'acknowledged newest';
  (merged.payload as import('../domain/models').Task).completed = true;
  await new PullWorker(
    store.adapter,
    {
      fetchPage: async (after) => {
        expect(after).toBe(11);
        return page([merged], 12);
      },
    },
    'owner',
  ).pull();
  expect(await store.db.tasks.get(id)).toMatchObject({
    title: 'acknowledged newest',
    completed: true,
    remoteRevision: 12,
  });
  expect(await store.db.syncMetadata.get(`ack:task:${id}`)).toBeUndefined();
});

it('merged ACK of v1 cannot acknowledge v2; its stamps and outbox survive reload until their own ACK', async () => {
  const store = await open();
  const id = await store.createTask('first');
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const flight = new PushWorker(store.adapter, {
    send: async (m) => {
      entered();
      await gate;
      return {
        mutationId: m.id,
        entityId: m.entityId,
        entityType: m.entityType,
        entityVersion: m.entityVersion,
        serverRevision: 10,
      };
    },
  }).push();
  await started;
  await store.changeTask(id, { title: 'second' });
  const expected = await store.db.tasks.get(id);
  release();
  await flight;
  expect(await store.db.outbox.toArray()).toMatchObject([{ entityVersion: 2, payload: expected }]);
  expect(await store.db.tasks.get(id)).toEqual(expected);
  await store.close();
  const reopened = await open(store.db.name);
  expect(await reopened.db.tasks.get(id)).toEqual(expected);
  expect(await reopened.db.outbox.count()).toBe(1);
  await new PushWorker(reopened.adapter, {
    send: async (m) => ({
      mutationId: m.id,
      entityId: m.entityId,
      entityType: m.entityType,
      entityVersion: m.entityVersion,
      serverRevision: 11,
    }),
  }).push();
  const merged: RemoteChange = {
    entityType: 'task',
    entityId: id,
    revision: 11,
    payload: {
      ...expected!,
      completed: true,
      remoteRevision: 11,
      fieldVersions: { ...expected!.fieldVersions!, completed: { counter: 2, deviceId: 'other' } },
    },
  };
  await new PullWorker(
    reopened.adapter,
    { fetchPage: async () => page([change(10, id), merged], 11) },
    'owner',
  ).pull();
  expect(await reopened.db.tasks.get(id)).toEqual(merged.payload);
  expect(await reopened.db.outbox.count()).toBe(0);
});

it.each([
  { title: '' },
  { completed: 'yes' },
  { dueDate: '2026-02-30' },
  { rank: 'broken' },
  { deletedAt: -1 },
  { fieldVersions: { title: { counter: -1, deviceId: 'device' } } },
])('rejects malformed remote fields without advancing the cursor: %j', async (invalid) => {
  const store = await open();
  const remote = change(1);
  Object.assign(remote.payload, invalid);
  await expect(
    new PullWorker(store.adapter, { fetchPage: async () => page([remote], 1) }, 'owner').pull(),
  ).rejects.toThrow('Invalid remote');
  expect(await store.db.tasks.count()).toBe(0);
  expect(await store.db.syncMetadata.get('pull-cursor')).toBeUndefined();
});

it.each(['task', 'list'] as const)(
  'pulls upgraded legacy %s records and continues after a local edit',
  async (kind) => {
    const store = await open();
    const legacy: RemoteChange =
      kind === 'task'
        ? change(9)
        : {
            revision: 9,
            entityId: 'remote',
            entityType: 'list',
            payload: {
              id: 'remote',
              ownerId: 'owner',
              remoteRevision: 9,
              version: 9,
              name: 'Legacy list',
            },
          };
    const upgraded = structuredClone(legacy);
    stampChanges(upgraded.payload, ['rank'], 'remote-device');
    upgraded.payload.rank = '80000000000000000000000000000000';
    upgraded.revision = 11;
    upgraded.payload.remoteRevision = 11;
    await new PullWorker(
      store.adapter,
      {
        fetchPage: async (after) =>
          after === 0 ? page([legacy], 9, true, 11) : page([upgraded], 11),
      },
      'owner',
      1,
    ).pull();
    const entities = kind === 'task' ? store.db.tasks : store.db.lists;
    expect(await entities.get('remote')).toEqual(upgraded.payload);
    expect((await store.db.syncMetadata.get('pull-cursor'))?.cursor).toBe(11);
    if (kind === 'task') await store.changeTask('remote', { completed: true });
    else await store.changeList('remote', { name: 'Edited list' });
    const edited = await entities.get('remote');
    expect(edited?.fieldVersions?.[kind === 'task' ? 'title' : 'rank']).toEqual(
      upgraded.payload.fieldVersions?.[kind === 'task' ? 'title' : 'rank'],
    );
    expect(await store.db.outbox.count()).toBe(1);
  },
);

it.each([
  { title: { counter: -1, deviceId: '' } },
  { title: { counter: 1.5, deviceId: '' } },
  { title: { counter: 1, deviceId: null } },
  { unknown: { counter: 1, deviceId: '' } },
])(
  'still rejects malformed field stamps without advancing the cursor: %j',
  async (fieldVersions) => {
    const store = await open();
    const remote = change(1);
    Object.assign(remote.payload, { fieldVersions });
    await expect(
      new PullWorker(store.adapter, { fetchPage: async () => page([remote], 1) }, 'owner').pull(),
    ).rejects.toThrow('Invalid remote record or owner');
    expect(await store.db.tasks.count()).toBe(0);
    expect(await store.db.syncMetadata.get('pull-cursor')).toBeUndefined();
  },
);
