import { afterEach, expect, it } from 'vitest';
import { Dexie } from 'dexie';
import { createStore } from '../db/store';
import type { Task } from '../domain/models';
import { taskFields } from '../domain/versions';
import { PullWorker, type PullTransport } from './pull';

const device = '11111111-1111-4111-8111-111111111111';
const remoteDevice = '22222222-2222-4222-8222-222222222222';
const stores: ReturnType<typeof createStore>[] = [];
async function open() {
  const store = createStore(crypto.randomUUID(), { ownerId: 'owner', deviceId: device });
  stores.push(store);
  await store.ready;
  return store;
}
afterEach(async () => {
  const opened = stores.splice(0);
  for (const store of opened) await store.close();
  for (const name of new Set(opened.map((store) => store.db.name))) await Dexie.delete(name);
});
function task(id: string, title: string, revision: number, counter = 1): Task {
  return {
    id,
    ownerId: 'owner',
    remoteRevision: revision,
    fieldVersions: Object.fromEntries(
      taskFields.map((field) => [
        field,
        {
          counter: ['title', 'completed'].includes(field) ? counter : 0,
          deviceId: ['title', 'completed'].includes(field) ? remoteDevice : '',
        },
      ]),
    ),
    title,
    completed: false,
    version: counter,
    createdAt: 1,
    updatedAt: 1,
  };
}
function resetTransport(records: Task[], generation = 'generation-new'): PullTransport {
  return {
    fetchPage: async () => ({ mode: 'reset', generation, until: 10 }),
    fetchSnapshotPage: async (requested, until, kind, after) => {
      const rows = kind === 'task' ? records.filter((record) => record.id > after) : [];
      return {
        generation: requested,
        until,
        kind,
        records: rows,
        cursor: '',
        hasMore: false,
      };
    },
  };
}
async function reset(store: Awaited<ReturnType<typeof open>>, transport: PullTransport) {
  await new PullWorker(store.adapter, transport, 'owner', 50, device).pull();
}

it('installs an initial snapshot and confirms generation and cursor atomically', async () => {
  const store = await open();
  const remote = task('00000000-0000-4000-8000-000000000001', 'restored', 7);
  await reset(store, resetTransport([remote]));
  expect(await store.db.tasks.toArray()).toEqual([remote]);
  expect(await store.db.syncMetadata.get('sync-state')).toMatchObject({
    generation: 'generation-new',
    cursor: 10,
  });
  expect(await store.db.syncMetadata.filter((row) => row.id.startsWith('snapshot:')).count()).toBe(
    0,
  );
});

it('does not alter the visible baseline when snapshot paging is interrupted', async () => {
  const store = await open();
  const old = task('00000000-0000-4000-8000-000000000001', 'old baseline', 4);
  await store.db.tasks.put(old);
  await store.db.syncMetadata.put({
    id: 'sync-state',
    revision: 0,
    generation: 'generation-old',
    cursor: 4,
  });
  let taskCalls = 0;
  const transport = resetTransport([]);
  transport.fetchSnapshotPage = async (generation, until, kind, after) => {
    if (kind === 'list')
      return { generation, until, kind, records: [], cursor: after, hasMore: false };
    taskCalls++;
    if (taskCalls === 2) throw new Error('interrupted');
    const first = task('00000000-0000-4000-8000-000000000002', 'new', 8);
    return { generation, until, kind, records: [first], cursor: first.id, hasMore: true };
  };
  await expect(reset(store, transport)).rejects.toThrow('interrupted');
  expect(await store.db.tasks.toArray()).toEqual([old]);
  expect(await store.db.syncMetadata.get('sync-state')).toMatchObject({
    generation: 'generation-old',
    cursor: 4,
  });
});

it('rejects a changes page from a stale generation without advancing state', async () => {
  const store = await open();
  await store.db.syncMetadata.put({
    id: 'sync-state',
    revision: 0,
    generation: 'generation-old',
    cursor: 0,
  });
  await expect(
    reset(store, {
      fetchPage: async () => ({
        mode: 'changes',
        generation: 'generation-new',
        changes: [],
        cursor: 0,
        until: 0,
        hasMore: false,
      }),
    }),
  ).rejects.toThrow('Invalid pull page');
  expect(await store.db.syncMetadata.get('sync-state')).toMatchObject({
    generation: 'generation-old',
    cursor: 0,
  });
});

it('preserves pending local state and rebases its immutable outbox onto the snapshot', async () => {
  const store = await open();
  const id = await store.createTask('pending local');
  const remote = task(id, 'restored old', 7);
  await reset(store, resetTransport([remote]));
  expect((await store.db.tasks.get(id))?.title).toBe('pending local');
  expect(await store.db.outbox.toArray()).toEqual([
    expect.objectContaining({ entityId: id, baseRevision: 7, retryCount: 0 }),
  ]);
});

it('requeues missing and field-newer acknowledged state as recovery mutations', async () => {
  const store = await open();
  const missingId = '00000000-0000-4000-8000-000000000001';
  const newerId = '00000000-0000-4000-8000-000000000002';
  const missing = task(missingId, 'created after backup', 12, 3);
  const newer = task(newerId, 'edited after backup', 13, 4);
  newer.fieldVersions!.title = { counter: 4, deviceId: device };
  await store.db.tasks.bulkPut([missing, newer]);
  const restored = task(newerId, 'from backup', 5, 1);
  await reset(store, resetTransport([restored]));
  expect((await store.db.tasks.get(newerId))?.title).toBe('edited after backup');
  expect(await store.db.outbox.toArray()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ entityId: missingId, operation: 'create', baseRevision: 0 }),
      expect.objectContaining({ entityId: newerId, operation: 'update', baseRevision: 5 }),
    ]),
  );
});

it('aborts the atomic switch when an equal field stamp carries a different value', async () => {
  const store = await open();
  const id = '00000000-0000-4000-8000-000000000001';
  const local = task(id, 'local', 8, 2);
  const restored = task(id, 'different', 5, 2);
  await store.db.tasks.put(local);
  await expect(reset(store, resetTransport([restored]))).rejects.toThrow(
    'Field stamp reused with different value',
  );
  expect(await store.db.tasks.get(id)).toEqual(local);
  expect(await store.db.syncMetadata.get('sync-state')).toBeUndefined();
});
