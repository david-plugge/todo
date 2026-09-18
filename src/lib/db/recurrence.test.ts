import { afterEach, describe, expect, it } from 'vitest';
import { occurrenceId } from '../domain/recurrence';
import { createStore } from './store';

const stores: ReturnType<typeof createStore>[] = [];
async function open(account = false) {
  const store = createStore(
    crypto.randomUUID(),
    account
      ? {
          ownerId: 'owner',
          deviceId: '00000000-0000-4000-8000-000000000001',
        }
      : undefined,
  );
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

describe('recurring task completion', () => {
  it('creates exactly one shifted successor and queues its immutable snapshot', async () => {
    const store = await open(true);
    const sourceId = await store.createTask('Team sync', {
      plannedDate: '2026-09-08',
      dueDate: '2026-09-10',
      recurrenceRule: 'FREQ=MONTHLY;BYDAY=2TU',
    });
    const source = store.tasks.get(sourceId)!;
    expect(source).toMatchObject({
      recurrenceRule: 'FREQ=MONTHLY;BYDAY=+2TU',
      recurrenceDate: '2026-09-08',
      seriesId: expect.any(String),
    });

    await store.changeTask(sourceId, { completed: true });

    const successorId = await occurrenceId(source.seriesId!, '2026-10-13');
    const successor = store.tasks.get(successorId);
    expect(successor).toMatchObject({
      title: 'Team sync',
      completed: false,
      plannedDate: '2026-10-13',
      dueDate: '2026-10-15',
      recurrenceDate: '2026-10-13',
      recurrenceRule: source.recurrenceRule,
      seriesId: source.seriesId,
      version: 1,
      fieldVersions: {
        recurrenceRule: { counter: 1 },
        recurrenceDate: { counter: 1 },
        seriesId: { counter: 1 },
      },
    });
    expect(await store.db.outbox.toArray()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityId: successorId,
          operation: 'create',
          payload: expect.objectContaining({
            recurrenceDate: '2026-10-13',
            completed: false,
          }),
        }),
      ]),
    );

    await store.changeTask(sourceId, { completed: true });
    expect(
      [...store.tasks.values()].filter((task) => task.seriesId === source.seriesId),
    ).toHaveLength(2);
  });

  it('rolls back completion and successor together when the outbox write fails', async () => {
    const store = await open();
    const sourceId = await store.createTask('Fortnightly', {
      plannedDate: '2026-09-15',
      recurrenceRule: 'FREQ=WEEKLY;INTERVAL=2',
    });
    const baseline = await store.db.outbox.toArray();
    store.db.outbox.hook('creating', () => {
      throw new Error('outbox failed');
    });

    await expect(store.changeTask(sourceId, { completed: true })).rejects.toThrow('outbox failed');

    expect(store.tasks.get(sourceId)?.completed).toBe(false);
    expect(store.tasks.size).toBe(1);
    expect(await store.db.outbox.toArray()).toEqual(baseline);
  });

  it('clears the internal series identity when recurrence is disabled', async () => {
    const store = await open();
    const id = await store.createTask('Temporary', {
      dueDate: '2026-09-18',
      recurrenceRule: 'FREQ=DAILY',
    });
    await store.changeTask(id, { recurrenceRule: null });
    expect(store.tasks.get(id)).toMatchObject({
      recurrenceRule: null,
      recurrenceDate: null,
      seriesId: null,
    });
  });
});
