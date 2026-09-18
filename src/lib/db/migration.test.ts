import { Dexie } from 'dexie';
import { expect, it } from 'vitest';
import { TodoDatabase } from './database';
import { createStore } from './store';

it('v1 outbox migrates atomically to one truthful current snapshot per entity', async () => {
  const name = crypto.randomUUID();
  const legacy = new Dexie(name);
  legacy.version(1).stores({
    tasks: 'id',
    lists: 'id',
    outbox: 'id, entityId, [entityType+entityId+entityVersion]',
    syncMetadata: 'id',
  });
  const task = {
    id: 'task',
    title: 'current',
    completed: true,
    version: 2,
    createdAt: 1,
    updatedAt: 2,
  };
  await legacy.table('tasks').add(task);
  for (const version of [1, 2])
    await legacy.table('outbox').add({
      id: `m${version}`,
      entityType: 'task',
      entityId: 'task',
      operation: version === 1 ? 'create' : 'update',
      entityVersion: version,
      createdAt: version,
      retryCount: 0,
    });
  legacy.close();
  const store = createStore(name);
  try {
    await store.ready;
    expect(await store.db.outbox.toArray()).toEqual([
      expect.objectContaining({ id: 'm2', entityVersion: 2, payload: task }),
    ]);
    expect(await store.db.tasks.get('task')).toEqual(task);
    expect(store.outbox.size).toBe(1);
  } finally {
    await store.close();
    await Dexie.delete(name);
  }
});

it('an unreconstructable v1 snapshot aborts the upgrade without dropping legacy data', async () => {
  const name = crypto.randomUUID();
  const legacy = new Dexie(name);
  const schema = {
    tasks: 'id',
    lists: 'id',
    outbox: 'id, entityId, [entityType+entityId+entityVersion]',
    syncMetadata: 'id',
  };
  legacy.version(1).stores(schema);
  const pending = {
    id: 'pending',
    entityType: 'task',
    entityId: 'missing',
    entityVersion: 1,
    operation: 'create',
    createdAt: 1,
    retryCount: 0,
  };
  await legacy.table('outbox').add(pending);
  legacy.close();
  const upgraded = new TodoDatabase(name);
  await expect(upgraded.open()).rejects.toThrow('Cannot reconstruct legacy outbox snapshot');
  upgraded.close();
  const original = new Dexie(name);
  original.version(1).stores(schema);
  try {
    await original.open();
    expect(original.verno).toBe(1);
    expect(await original.table('outbox').toArray()).toEqual([pending]);
  } finally {
    original.close();
    await Dexie.delete(name);
  }
});
