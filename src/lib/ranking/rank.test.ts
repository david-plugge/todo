import { afterEach, expect, it } from 'vitest';
import { createStore } from '../db/store';
import { balanced, between, compareRank, planPlacement, validRank } from './rank';
import { validDate } from '../domain/dates';
const stores: ReturnType<typeof createStore>[] = [];
async function open(name: string = crypto.randomUUID()) {
  const store = createStore(name, {
    ownerId: 'owner',
    deviceId: '00000000-0000-4000-8000-000000000001',
  });
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

it('supports before, after and between with lexicographically ordered bounded keys', () => {
  const middle = between(null, null)!;
  const first = between(null, middle)!;
  const last = between(middle, null)!;
  expect([last, first, middle].sort()).toEqual([first, middle, last]);
  const inner = between(first, middle)!;
  expect(first < inner && inner < middle).toBe(true);
  expect([first, middle, last, inner].every(validRank)).toBe(true);
  expect(between(first, first)).toBeNull();
  expect(() => between('invalid', null)).toThrow('Invalid rank');
  expect(validRank('0'.repeat(32))).toBe(false);
  expect(validRank('f'.repeat(32))).toBe(false);
});

it('500 repeated inserts into one gap trigger repair and retain exact requested order', () => {
  const keys = balanced(2);
  let rows = [
    { id: 'left', rank: keys[0] },
    { id: 'right', rank: keys[1] },
  ];
  let repairs = 0;
  for (let index = 0; index < 500; index++) {
    const id = `new-${index}`;
    const plan = planPlacement(rows, id, 'right');
    if (plan.size > 1) repairs++;
    rows = rows.map((row) => ({ ...row, rank: plan.get(row.id) ?? row.rank }));
    rows.push({ id, rank: plan.get(id)! });
  }
  expect(repairs).toBeGreaterThan(0);
  expect(rows.sort(compareRank).map((row) => row.id)).toEqual([
    'left',
    ...Array.from({ length: 500 }, (_, i) => `new-${i}`),
    'right',
  ]);
  expect(rows.every((row) => row.rank.length === 32 && validRank(row.rank))).toBe(true);
  expect(new Set(rows.map((row) => row.rank)).size).toBe(502);
});

it('offline rank collisions have a stable ID tie-break and can be split with a rebalance', () => {
  const rank = between(null, null)!;
  const rows = [
    { id: 'b', rank },
    { id: 'a', rank },
  ];
  expect([...rows].sort(compareRank).map((row) => row.id)).toEqual(['a', 'b']);
  const plan = planPlacement(rows, 'insert', 'b');
  expect(plan.size).toBe(3);
  expect(
    [...rows, { id: 'insert', rank }]
      .map((row) => ({ ...row, rank: plan.get(row.id)! }))
      .sort(compareRank)
      .map((row) => row.id),
  ).toEqual(['a', 'insert', 'b']);
});

it('moves first/last, inserts before, reorders lists, and survives reload without renumbering normal neighbors', async () => {
  const store = await open();
  const a = await store.createTask('A');
  const c = await store.createTask('C');
  const b = await store.createTask('B', {}, c);
  const order = () => [...store.tasks.values()].sort(compareRank).map((row) => row.id);
  expect(order()).toEqual([a, b, c]);
  const oldA = await store.db.tasks.get(a);
  await store.moveTask(c, a);
  expect(order()).toEqual([c, a, b]);
  expect(await store.db.tasks.get(a)).toEqual(oldA);
  await store.moveTask(c, null);
  expect(order()).toEqual([a, b, c]);
  const l1 = await store.createList('First'),
    l2 = await store.createList('Second');
  await store.moveList(l2, l1);
  expect([...store.lists.values()].sort(compareRank).map((row) => row.id)).toEqual([l2, l1]);
  await store.close();
  const reopened = await open(store.db.name);
  expect([...reopened.tasks.values()].sort(compareRank).map((row) => row.id)).toEqual([a, b, c]);
  expect(
    (await reopened.db.outbox.toArray())
      .filter((row) => row.entityId === c)
      .map((row) => row.payload.rank),
  ).toHaveLength(3);
});

it('legacy ranks are assigned on a real write; failed rebalance rolls back ALL ranks and outbox entries', async () => {
  const store = await open();
  const a = await store.createTask('A');
  const b = await store.createTask('B');
  await store.adapter.write(['tasks'], async () => {
    await store.db.tasks.update(a, { rank: '00000000000000000000000000000001' });
    await store.db.tasks.update(b, { rank: '00000000000000000000000000000002' });
  });
  const before = await store.db.tasks.toArray();
  const pending = await store.db.outbox.toArray();
  let writes = 0;
  const fail = () => {
    if (++writes === 2) throw new Error('rebalance interrupted');
  };
  store.db.outbox.hook('creating', fail);
  await expect(store.createTask('between', {}, b)).rejects.toThrow('rebalance interrupted');
  expect(await store.db.tasks.toArray()).toEqual(before);
  expect(await store.db.outbox.toArray()).toEqual(pending);
  store.db.outbox.hook('creating').unsubscribe(fail);
  const inserted = await store.createTask('between', {}, b);
  expect([...store.tasks.values()].sort(compareRank).map((row) => row.id)).toEqual([
    a,
    inserted,
    b,
  ]);
  await store.rebalance('task');
  expect(new Set([...store.tasks.values()].map((row) => row.rank)).size).toBe(3);
});

it('old unranked tasks keep their relative order and acquire ranks with their outbox atomically', async () => {
  const store = await open();
  await store.adapter.write(['tasks'], async () => {
    for (const [id, createdAt] of [
      ['old-b', 2],
      ['old-a', 1],
    ] as const)
      await store.db.tasks.put({
        id,
        title: id,
        completed: false,
        version: 1,
        createdAt,
        updatedAt: createdAt,
      });
  });
  const last = await store.createTask('new');
  expect([...store.tasks.values()].sort(compareRank).map((row) => row.id)).toEqual([
    'old-a',
    'old-b',
    last,
  ]);
  expect((await store.db.outbox.toArray()).map((row) => row.entityId).sort()).toEqual(
    ['old-a', 'old-b', last].sort(),
  );
});

it('calendar dates reject invalid days, persist and clear with independent stamps and immutable snapshots', async () => {
  expect(validDate('2028-02-29')).toBe(true);
  for (const bad of [
    '2027-02-29',
    '2026-02-30',
    '2026-13-01',
    '2026-01-01T00:00:00Z',
    '0000-01-01',
    '',
    undefined,
  ])
    expect(validDate(bad)).toBe(false);
  const store = await open();
  const id = await store.createTask('dates', { dueDate: '2026-10-01', plannedDate: '2026-09-30' });
  const initial = (await store.db.tasks.get(id))!;
  await store.changeTask(id, { dueDate: null });
  const cleared = (await store.db.tasks.get(id))!;
  expect(cleared).toMatchObject({ dueDate: null, plannedDate: '2026-09-30' });
  expect(cleared.fieldVersions?.plannedDate).toEqual(initial.fieldVersions?.plannedDate);
  expect(cleared.fieldVersions?.dueDate.counter).toBeGreaterThan(
    initial.fieldVersions!.dueDate.counter,
  );
  const old = (await store.db.outbox.toArray()).find((row) => row.entityVersion === 1)!;
  expect(old.payload).toMatchObject({ dueDate: '2026-10-01', plannedDate: '2026-09-30' });
  await expect(store.changeTask(id, { dueDate: '2026-02-30' })).rejects.toThrow('Kalenderdatum');
  await store.close();
  const reopened = await open(store.db.name);
  expect(await reopened.db.tasks.get(id)).toEqual(cleared);
});
