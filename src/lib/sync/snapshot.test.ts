import { afterEach, expect, it } from 'vitest';
import { Dexie } from 'dexie';
import { createStore } from '../db/store';
import type { Task } from '../domain/models';
import { taskFields } from '../domain/versions';
import { PullWorker, type PullTransport } from './pull';
import { PushWorker, type PushAck, type PushMutation } from './push';

const device = '11111111-1111-4111-8111-111111111111';
const remoteDevice = '22222222-2222-4222-8222-222222222222';
const stores: ReturnType<typeof createStore>[] = [];
async function open(name: string = crypto.randomUUID()) {
  const store = createStore(name, { ownerId: 'owner', deviceId: device });
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
  const original = (await store.db.outbox.toArray())[0];
  const remote = task(id, 'restored old', 7);
  await reset(store, resetTransport([remote]));
  expect((await store.db.tasks.get(id))?.title).toBe('pending local');
  expect(await store.db.outbox.toArray()).toEqual([
    expect.objectContaining({ entityId: id, baseRevision: 7, retryCount: 0 }),
  ]);
  expect((await store.db.outbox.toArray())[0].id).not.toBe(original.id);
});

it('uses isolated staging sessions when two tabs restore the same generation concurrently', async () => {
  const first = await open();
  const second = await open(first.db.name);
  const a = task('00000000-0000-4000-8000-000000000001', 'first page', 7);
  const b = task('00000000-0000-4000-8000-000000000002', 'second page', 8);
  const waiting = deferred();
  const release = deferred();
  const slow = resetTransport([]);
  slow.fetchSnapshotPage = async (generation, until, kind, after) => {
    if (kind === 'list')
      return { generation, until, kind, records: [], cursor: '', hasMore: false };
    if (!after) return { generation, until, kind, records: [a], cursor: a.id, hasMore: true };
    waiting.resolve();
    await release.promise;
    return { generation, until, kind, records: [b], cursor: '', hasMore: false };
  };
  const slowReset = reset(first, slow);
  await waiting.promise;
  const [liveSession] = await first.db.syncMetadata
    .filter((row) => row.id.startsWith('snapshot-session:'))
    .toArray();
  expect(liveSession).toMatchObject({
    generation: 'generation-new',
    createdAt: expect.any(Number),
    leaseUntil: expect.any(Number),
  });
  expect(liveSession.leaseUntil!).toBeGreaterThan(liveSession.createdAt!);
  await reset(second, resetTransport([a, b]));
  expect(
    await first.db.syncMetadata
      .filter((row) => row.id.startsWith('snapshot-session:') || row.id.startsWith('snapshot:'))
      .count(),
  ).toBe(0);
  release.resolve();
  await expect(slowReset).rejects.toThrow('Snapshot session changed');
  expect(await first.db.tasks.orderBy('id').toArray()).toEqual([a, b]);
  expect(
    await first.db.syncMetadata
      .filter((row) => row.id.startsWith('snapshot:') || row.id.startsWith('snapshot-session:'))
      .count(),
  ).toBe(0);
});

it('collects expired and orphaned staging before download without touching a live lease', async () => {
  const store = await open();
  const now = Date.now();
  const staleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const liveId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const staleRows = Array.from({ length: 128 }, (_, index) => ({
    id: `snapshot:${staleId}:task:${index.toString().padStart(4, '0')}`,
    revision: index + 1,
    generation: 'stale-generation',
    until: 200,
    kind: 'task' as const,
    entityId: String(index),
    payload: task(crypto.randomUUID(), `stale ${index}`, index + 1),
  }));
  await store.db.syncMetadata.bulkPut([
    {
      id: `snapshot-session:${staleId}`,
      revision: 0,
      createdAt: now - 120_000,
      leaseUntil: now - 60_000,
      generation: 'stale-generation',
      until: 200,
    },
    ...staleRows,
    {
      id: 'snapshot:orphan-without-session:task:one',
      revision: 1,
      generation: 'orphan-generation',
      until: 1,
    },
    {
      id: `snapshot-session:${liveId}`,
      revision: 0,
      createdAt: now,
      leaseUntil: now + 60_000,
      generation: 'live-generation',
      until: 10,
    },
    {
      id: `snapshot:${liveId}:task:one`,
      revision: 1,
      generation: 'live-generation',
      until: 10,
    },
  ]);
  let inspected = false;
  await reset(store, {
    fetchPage: async () => ({ mode: 'reset', generation: 'generation-new', until: 10 }),
    fetchSnapshotPage: async (generation, until, kind) => {
      if (!inspected) {
        inspected = true;
        expect(await store.db.syncMetadata.get(`snapshot-session:${staleId}`)).toBeUndefined();
        expect(
          await store.db.syncMetadata
            .filter((row) => row.id.startsWith(`snapshot:${staleId}:`))
            .count(),
        ).toBe(0);
        expect(
          await store.db.syncMetadata.get('snapshot:orphan-without-session:task:one'),
        ).toBeUndefined();
        expect(await store.db.syncMetadata.get(`snapshot-session:${liveId}`)).toBeDefined();
        expect(await store.db.syncMetadata.get(`snapshot:${liveId}:task:one`)).toBeDefined();
      }
      return { generation, until, kind, records: [], cursor: '', hasMore: false };
    },
  });
  expect(inspected).toBe(true);
  expect(await store.db.syncMetadata.get(`snapshot-session:${liveId}`)).toBeUndefined();
  expect(await store.db.syncMetadata.get(`snapshot:${liveId}:task:one`)).toBeUndefined();
});

it('same-target skip removes old-baseline sessions but preserves a live current-baseline session', async () => {
  const store = await open();
  const now = Date.now();
  const obsoleteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const futureId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const satisfiedId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  await store.db.syncMetadata.bulkPut([
    {
      id: 'sync-state',
      revision: 0,
      generation: 'generation-new',
      cursor: 10,
    },
    {
      id: `snapshot-session:${obsoleteId}`,
      revision: 0,
      createdAt: now,
      leaseUntil: now + 60_000,
      generation: 'generation-new',
      until: 10,
      sourceGeneration: 'generation-old',
      sourceCursor: 0,
    },
    {
      id: `snapshot:${obsoleteId}:task:one`,
      revision: 1,
      generation: 'generation-new',
      until: 10,
    },
    {
      id: `snapshot-session:${satisfiedId}`,
      revision: 0,
      createdAt: now,
      leaseUntil: now + 60_000,
      generation: 'generation-new',
      until: 10,
      sourceGeneration: 'generation-new',
      sourceCursor: 10,
    },
    {
      id: `snapshot:${satisfiedId}:task:one`,
      revision: 1,
      generation: 'generation-new',
      until: 10,
    },
    {
      id: `snapshot-session:${futureId}`,
      revision: 0,
      createdAt: now,
      leaseUntil: now + 60_000,
      generation: 'generation-future',
      until: 20,
      sourceGeneration: 'generation-new',
      sourceCursor: 10,
    },
    {
      id: `snapshot:${futureId}:task:one`,
      revision: 1,
      generation: 'generation-future',
      until: 20,
    },
  ]);
  await reset(store, resetTransport([], 'generation-new'));
  expect(await store.db.syncMetadata.get(`snapshot-session:${obsoleteId}`)).toBeUndefined();
  expect(await store.db.syncMetadata.get(`snapshot:${obsoleteId}:task:one`)).toBeUndefined();
  expect(await store.db.syncMetadata.get(`snapshot-session:${satisfiedId}`)).toBeUndefined();
  expect(await store.db.syncMetadata.get(`snapshot:${satisfiedId}:task:one`)).toBeUndefined();
  expect(await store.db.syncMetadata.get(`snapshot-session:${futureId}`)).toBeDefined();
  expect(await store.db.syncMetadata.get(`snapshot:${futureId}:task:one`)).toBeDefined();
  expect(
    await store.db.syncMetadata.filter((row) => row.id.startsWith('snapshot-session:')).count(),
  ).toBe(1);
});

it('gives a rebased lost-ACK request a new mutation ID instead of conflicting with its receipt', async () => {
  const store = await open();
  const id = await store.createTask('lost ACK before restore');
  const original = (await store.db.outbox.toArray())[0];
  const originalRequest: PushMutation = {
    id: original.id,
    entityId: original.entityId,
    entityType: original.entityType,
    entityVersion: original.entityVersion,
    operation: original.operation,
    payload: structuredClone(original.payload),
    deviceId: original.deviceId,
    baseRevision: original.baseRevision,
  };
  const restored = structuredClone((await store.db.tasks.get(id))!);
  restored.remoteRevision = 7;
  await reset(store, resetTransport([restored]));
  const [rebased] = await store.db.outbox.toArray();
  expect(rebased).toMatchObject({ entityId: id, baseRevision: 7 });
  expect(rebased.id).not.toBe(original.id);
  const requests: PushMutation[] = [];
  await expect(
    new PushWorker(store.adapter, {
      send: async (mutation) => {
        requests.push(structuredClone(mutation));
        if (mutation.id === originalRequest.id) {
          if (JSON.stringify(mutation) !== JSON.stringify(originalRequest))
            throw new Error('409 Idempotency key reused with different payload');
        }
        return {
          mutationId: mutation.id,
          entityId: mutation.entityId,
          entityType: mutation.entityType,
          entityVersion: mutation.entityVersion,
          serverRevision: 8,
        };
      },
    }).push(),
  ).resolves.toBe(1);
  expect(requests).toEqual([
    expect.objectContaining({ id: rebased.id, baseRevision: 7, entityId: id }),
  ]);
  expect(await store.db.outbox.count()).toBe(0);
});

it('makes a delayed pre-restore ACK inert across tabs even when the base revision is unchanged', async () => {
  const first = await open();
  const second = await open(first.db.name);
  await first.db.syncMetadata.put({
    id: 'sync-state',
    revision: 0,
    generation: 'generation-old',
    cursor: 0,
  });
  const id = await first.createTask('pending across restore');
  const started = deferred<{ mutation: PushMutation; generation: string }>();
  const release = deferred<PushAck>();
  const oldFlight = new PushWorker(first.adapter, {
    send: async (mutation, generation) => {
      started.resolve({ mutation: structuredClone(mutation), generation });
      return release.promise;
    },
  }).push();
  const old = await started.promise;
  expect(old.generation).toBe('generation-old');
  expect(old.mutation.baseRevision).toBe(0);
  await reset(second, resetTransport([], 'generation-new'));
  const [requeued] = await second.db.outbox.toArray();
  expect(requeued).toMatchObject({ entityId: id, baseRevision: 0 });
  expect(requeued.id).not.toBe(old.mutation.id);
  release.resolve({
    mutationId: old.mutation.id,
    entityId: old.mutation.entityId,
    entityType: old.mutation.entityType,
    entityVersion: old.mutation.entityVersion,
    serverRevision: 11,
  });
  await expect(oldFlight).resolves.toBe(0);
  expect(await second.db.outbox.toArray()).toEqual([requeued]);
  expect(await second.db.syncMetadata.get(`ack:task:${id}`)).toBeUndefined();
  await expect(
    new PushWorker(second.adapter, {
      send: async (mutation, generation) => {
        expect(generation).toBe('generation-new');
        expect(mutation.id).toBe(requeued.id);
        return {
          mutationId: mutation.id,
          entityId: mutation.entityId,
          entityType: mutation.entityType,
          entityVersion: mutation.entityVersion,
          serverRevision: 12,
        };
      },
    }).push(),
  ).resolves.toBe(1);
  expect(await second.db.outbox.count()).toBe(0);
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

it('preserves a missing acknowledged legacy record through the legacy base-revision path', async () => {
  const store = await open();
  const legacy = task('00000000-0000-4000-8000-000000000001', 'legacy after backup', 12, 3);
  delete legacy.fieldVersions;
  await store.db.tasks.put(legacy);
  await reset(store, resetTransport([]));
  const recovered = await store.db.tasks.get(legacy.id);
  expect(recovered).toEqual({
    ...legacy,
    remoteRevision: 0,
  });
  expect(await store.db.outbox.toArray()).toEqual([
    expect.objectContaining({
      entityId: legacy.id,
      operation: 'create',
      baseRevision: 0,
      payload: recovered,
    }),
  ]);
});

it('merges a newer acknowledged legacy record over an older restored record', async () => {
  const store = await open();
  const id = '00000000-0000-4000-8000-000000000001';
  const local = task(id, 'newer legacy local', 12, 1);
  local.updatedAt = 40;
  delete local.fieldVersions;
  const restored = task(id, 'older restored', 5, 1);
  restored.updatedAt = 10;
  delete restored.fieldVersions;
  await store.db.tasks.put(local);
  await reset(store, resetTransport([restored]));
  expect(await store.db.tasks.get(id)).toMatchObject({
    title: 'newer legacy local',
    version: 1,
    remoteRevision: 5,
    updatedAt: 40,
  });
  expect((await store.db.tasks.get(id))?.fieldVersions).toBeUndefined();
  expect(await store.db.outbox.toArray()).toEqual([
    expect.objectContaining({
      entityId: id,
      operation: 'update',
      baseRevision: 5,
      payload: expect.objectContaining({ title: 'newer legacy local' }),
    }),
  ]);
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
