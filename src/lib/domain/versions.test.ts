import { afterEach, expect, it } from 'vitest';
import { createStore } from '../db/store';
const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';
const stores: ReturnType<typeof createStore>[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.close();
    await store.db.delete();
  }
});

it('persists only changed field stamps atomically, survives reload, and rolls back on outbox failure', async () => {
  const store = createStore(crypto.randomUUID(), { ownerId: 'owner', deviceId: a });
  stores.push(store);
  await store.ready;
  const id = await store.createTask('initial');
  const initial = await store.db.tasks.get(id);
  await store.changeTask(id, { title: 'edited' });
  const edited = (await store.db.tasks.get(id))!;
  expect(edited.fieldVersions?.completed).toEqual(initial?.fieldVersions?.completed);
  expect(edited.fieldVersions?.title).toEqual({ counter: 2, deviceId: a });
  const entries = await store.db.outbox.toArray();
  expect(entries.find((e) => e.entityVersion === 1)?.payload).toEqual(initial);
  expect(entries.find((e) => e.entityVersion === 2)?.payload).toEqual(edited);
  await store.close();
  const reopened = createStore(store.db.name, { ownerId: 'owner', deviceId: a });
  stores.push(reopened);
  await reopened.ready;
  reopened.db.outbox.hook('creating', () => {
    throw new Error('outbox failed');
  });
  await expect(reopened.changeTask(id, { completed: true })).rejects.toThrow('outbox failed');
  expect(await reopened.db.tasks.get(id)).toEqual(edited);
  expect(await reopened.db.outbox.toArray()).toEqual(entries);
});

it('list edits persist stamps and a full immutable outbox snapshot; local delete cannot be undone', async () => {
  const store = createStore(crypto.randomUUID(), { ownerId: 'owner', deviceId: b });
  stores.push(store);
  await store.ready;
  const id = await store.createList('Inbox');
  await store.changeList(id, { name: 'Later' });
  await store.changeList(id, { deletedAt: 42 });
  expect(await store.db.lists.get(id)).toMatchObject({
    name: 'Later',
    deletedAt: 42,
    fieldVersions: { name: { counter: 2, deviceId: b }, deletedAt: { counter: 3, deviceId: b } },
  });
  expect(
    (await store.db.outbox.toArray()).find((e) => e.entityVersion === 2)?.payload,
  ).toMatchObject({ name: 'Later', version: 2 });
  await expect(store.changeList(id, { name: 'resurrect' })).rejects.toThrow('Deleted lists');
});

it('deleting a list retains active tasks, including completed ones, as unassigned', async () => {
  const store = createStore(crypto.randomUUID(), { ownerId: 'owner', deviceId: b });
  stores.push(store);
  const listId = await store.createList('Inbox');
  const taskId = await store.createTask('Keep me', { listId });
  const completedId = await store.createTask('Completed', { listId });
  const unrelatedId = await store.createTask('Unrelated');
  await store.changeTask(completedId, { completed: true });

  await store.deleteList(listId);

  expect(await store.db.lists.get(listId)).toMatchObject({ deletedAt: expect.any(Number) });
  expect(await store.db.tasks.get(taskId)).toMatchObject({ listId: null });
  expect(await store.db.tasks.get(completedId)).toMatchObject({ completed: true, listId: null });
  expect(await store.db.tasks.get(unrelatedId)).not.toHaveProperty('deletedAt');
  expect(await store.db.outbox.toArray()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ entityType: 'list', entityId: listId, operation: 'delete' }),
      expect.objectContaining({ entityType: 'task', entityId: taskId, operation: 'update' }),
    ]),
  );
});

it('deleting a list with deleteTasks tombstones only its active tasks atomically', async () => {
  const store = createStore(crypto.randomUUID(), { ownerId: 'owner', deviceId: b });
  stores.push(store);
  const listId = await store.createList('Inbox');
  const activeId = await store.createTask('Active', { listId });
  const completedId = await store.createTask('Completed', { listId });
  const deletedId = await store.createTask('Already deleted', { listId });
  const unrelatedId = await store.createTask('Unrelated');
  await store.changeTask(completedId, { completed: true });
  await store.changeTask(deletedId, { deletedAt: 1 });

  await store.deleteList(listId, { deleteTasks: true });

  expect(await store.db.lists.get(listId)).toMatchObject({ deletedAt: expect.any(Number) });
  expect(await store.db.tasks.get(activeId)).toMatchObject({
    deletedAt: expect.any(Number),
    listId,
  });
  expect(await store.db.tasks.get(completedId)).toMatchObject({
    completed: true,
    deletedAt: expect.any(Number),
    listId,
  });
  expect(await store.db.tasks.get(deletedId)).toMatchObject({ deletedAt: 1, listId });
  expect(await store.db.tasks.get(unrelatedId)).toMatchObject({ listId: null });
  expect(await store.db.tasks.get(unrelatedId)).not.toHaveProperty('deletedAt');
  expect(await store.db.outbox.toArray()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ entityType: 'list', entityId: listId, operation: 'delete' }),
      expect.objectContaining({ entityType: 'task', entityId: activeId, operation: 'delete' }),
      expect.objectContaining({ entityType: 'task', entityId: completedId, operation: 'delete' }),
    ]),
  );
});

it('rolls back a list deletion with deleteTasks when an outbox write fails', async () => {
  const store = createStore(crypto.randomUUID(), { ownerId: 'owner', deviceId: b });
  stores.push(store);
  const listId = await store.createList('Inbox');
  const taskId = await store.createTask('Active', { listId });
  const baseline = await store.db.outbox.toArray();
  store.db.outbox.hook('creating', () => {
    throw new Error('outbox failed');
  });

  await expect(store.deleteList(listId, { deleteTasks: true })).rejects.toThrow('outbox failed');

  expect(await store.db.lists.get(listId)).not.toHaveProperty('deletedAt');
  expect(await store.db.tasks.get(taskId)).toMatchObject({ listId });
  expect(await store.db.tasks.get(taskId)).not.toHaveProperty('deletedAt');
  expect(await store.db.outbox.toArray()).toEqual(baseline);
});
