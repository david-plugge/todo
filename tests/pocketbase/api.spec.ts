import { expect, test, type APIRequestContext } from '@playwright/test';
import { bootstrapSyncGeneration, changesPull, syncHeaders } from './sync-api';
async function login(request: APIRequestContext, name: string) {
  const response = await request.post('/api/collections/todo_users/auth-with-password', {
    data: { identity: `${name}@example.test`, password: 'test-password-12345!' },
  });
  expect(response.status()).toBe(200);
  const result = await response.json();
  const generation = await bootstrapSyncGeneration(request, result.token);
  return {
    owner: result.record.id as string,
    generation,
    headers: syncHeaders(result.token, generation),
  };
}
function mutation(owner: string, overrides: Record<string, unknown> = {}) {
  const entityId = crypto.randomUUID();
  return {
    id: crypto.randomUUID(),
    entityId,
    entityType: 'task',
    entityVersion: 1,
    operation: 'create',
    deviceId: crypto.randomUUID(),
    baseRevision: 0,
    payload: {
      id: entityId,
      ownerId: owner,
      title: 'PB task',
      completed: false,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    ...overrides,
  };
}

test('authenticated push is idempotent; ownership and direct-write rules are enforced', async ({
  request,
}) => {
  const a = await login(request, 'api-owner');
  const b = await login(request, 'api-other');
  const m = mutation(a.owner);
  expect((await request.post('/api/todo/push', { data: m })).status()).toBe(401);
  expect((await request.get('/api/todo/pull')).status()).toBe(401);
  for (const generation of [undefined, crypto.randomUUID()]) {
    const headers = generation
      ? syncHeaders(a.headers.Authorization, generation)
      : { Authorization: a.headers.Authorization };
    expect((await request.post('/api/todo/push', { headers, data: m })).status()).toBe(409);
  }
  const before = await (
    await request.get('/api/collections/tasks/records', { headers: a.headers })
  ).json();
  expect(before.items).toHaveLength(0);
  const first = await request.post('/api/todo/push', { headers: a.headers, data: m });
  expect(first.status()).toBe(200);
  const ack = await first.json();
  expect(ack.serverRevision).toBeGreaterThan(0);
  const repeated = await request.post('/api/todo/push', { headers: a.headers, data: m });
  expect(repeated.status()).toBe(200);
  expect(await repeated.json()).toEqual(ack);
  expect(
    (
      await request.post('/api/todo/push', {
        headers: a.headers,
        data: { ...m, payload: { ...m.payload, title: 'different' } },
      })
    ).status(),
  ).toBe(409);
  expect((await request.post('/api/todo/push', { headers: b.headers, data: m })).status()).toBe(
    400,
  );
  const own = await (
    await request.get('/api/collections/tasks/records', { headers: a.headers })
  ).json();
  expect(own.items).toHaveLength(1);
  const other = await (
    await request.get('/api/collections/tasks/records', { headers: b.headers })
  ).json();
  expect(other.items).toHaveLength(0);
  expect(
    (
      await request.get(`/api/collections/tasks/records/${own.items[0].id}`, { headers: b.headers })
    ).status(),
  ).toBe(404);
  for (const auth of [a, b]) {
    expect(
      (
        await request.patch(`/api/collections/tasks/records/${own.items[0].id}`, {
          headers: auth.headers,
          data: { owner: b.owner },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await request.delete(`/api/collections/tasks/records/${own.items[0].id}`, {
          headers: auth.headers,
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await request.post('/api/collections/tasks/records', { headers: auth.headers, data: {} })
      ).status(),
    ).toBe(403);
  }
  const pullA = await (
    await request.get(changesPull('/api/todo/pull', a.generation), { headers: a.headers })
  ).json();
  expect(pullA.changes).toHaveLength(1);
  const pullB = await (
    await request.get(changesPull('/api/todo/pull', b.generation), { headers: b.headers })
  ).json();
  expect(pullB.changes).toHaveLength(0);
  expect(
    (await request.get('/api/collections/todo_receipts/records', { headers: a.headers })).status(),
  ).toBe(403);
});

test('stable revision cursor pages all changes including tombstones and concurrent later inserts', async ({
  request,
}) => {
  const a = await login(request, 'paging');
  const mutations = [];
  for (let i = 0; i < 5; i++) {
    const m = mutation(a.owner);
    mutations.push(m);
    expect((await request.post('/api/todo/push', { headers: a.headers, data: m })).status()).toBe(
      200,
    );
  }
  const first = await (
    await request.get(changesPull('/api/todo/pull?limit=2', a.generation), {
      headers: a.headers,
    })
  ).json();
  expect(first.changes).toHaveLength(2);
  expect(first.hasMore).toBe(true);
  const deleted = mutations[0];
  expect(
    (
      await request.post('/api/todo/push', {
        headers: a.headers,
        data: {
          ...deleted,
          id: crypto.randomUUID(),
          operation: 'delete',
          entityVersion: 2,
          payload: { ...deleted.payload, version: 2, deletedAt: 10 },
        },
      })
    ).status(),
  ).toBe(200);
  const all = [...first.changes];
  let cursor = first.cursor;
  let more = first.hasMore;
  while (more) {
    const page = await (
      await request.get(
        changesPull(`/api/todo/pull?limit=2&after=${cursor}&until=${first.until}`, a.generation),
        {
          headers: a.headers,
        },
      )
    ).json();
    all.push(...page.changes);
    expect(page.cursor).toBeGreaterThan(cursor);
    cursor = page.cursor;
    more = page.hasMore;
  }
  expect(all).toHaveLength(5);
  expect(new Set(all.map((c) => c.revision)).size).toBe(5);
  expect(cursor).toBe(first.until);
  const next = await (
    await request.get(changesPull(`/api/todo/pull?after=${cursor}`, a.generation), {
      headers: a.headers,
    })
  ).json();
  expect(next.changes).toHaveLength(1);
  expect(next.changes[0].payload.deletedAt).toBe(10);
  for (const query of ['after=-1', 'after=1.5', 'limit=0', 'until=99999999999999999999'])
    expect(
      (
        await request.get(changesPull(`/api/todo/pull?${query}`, a.generation), {
          headers: a.headers,
        })
      ).status(),
    ).toBe(400);

  const resetBeforeCursorValidation = await request.get('/api/todo/pull?after=invalid', {
    headers: { Authorization: a.headers.Authorization },
  });
  expect(resetBeforeCursorValidation.status()).toBe(200);
  expect(await resetBeforeCursorValidation.json()).toMatchObject({
    mode: 'reset',
    generation: a.generation,
  });
});

test('legacy different-device conflicts remain pending; lists use the protected push/pull path', async ({
  request,
}) => {
  const a = await login(request, 'conflict');
  const m = mutation(a.owner);
  const created = await (
    await request.post('/api/todo/push', { headers: a.headers, data: m })
  ).json();
  const edit = {
    ...m,
    id: crypto.randomUUID(),
    deviceId: crypto.randomUUID(),
    baseRevision: created.serverRevision,
    entityVersion: 2,
    operation: 'update',
    payload: { ...m.payload, title: 'winner', version: 2 },
  };
  expect((await request.post('/api/todo/push', { headers: a.headers, data: edit })).status()).toBe(
    200,
  );
  expect(
    (
      await request.post('/api/todo/push', {
        headers: a.headers,
        data: {
          ...edit,
          id: crypto.randomUUID(),
          deviceId: crypto.randomUUID(),
          payload: { ...edit.payload, title: 'loser' },
        },
      })
    ).status(),
  ).toBe(409);
  const listId = crypto.randomUUID();
  const list = mutation(a.owner, {
    entityId: listId,
    entityType: 'list',
    payload: { id: listId, ownerId: a.owner, name: 'Inbox', version: 1 },
  });
  expect((await request.post('/api/todo/push', { headers: a.headers, data: list })).status()).toBe(
    200,
  );
  const pulled = await (
    await request.get(changesPull('/api/todo/pull', a.generation), { headers: a.headers })
  ).json();
  expect(pulled.changes).toHaveLength(3);
  expect(pulled.changes[1].payload.title).toBe('winner');
  expect(pulled.changes[2].entityType).toBe('list');
});
