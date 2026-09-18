import { triggerSync } from './navigation-helpers';
import { authorize } from './oauth-helpers';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Task } from '../../src/lib/domain/models';

async function login(request: APIRequestContext, name: string) {
  const response = await request.post('/api/collections/todo_users/auth-with-password', {
    data: { identity: `${name}@example.test`, password: 'test-password-12345!' },
  });
  expect(response.ok()).toBe(true);
  const auth = await response.json();
  const flow = await authorize(request, auth.token);
  return {
    token: flow.tokens.access_token as string,
    pbToken: auth.token as string,
    record: auth.record,
  };
}
async function connect(token: string) {
  const client = new Client({ name: 'todo-integration-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8091/api/todo/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return result.structuredContent as {
    entity: Task;
    revision: number;
    items: Task[];
    nextCursor: string | null;
  };
}

test('official MCP SDK: discovery, owner isolation, CRUD, receipts and calendar/list validation', async ({
  request,
}) => {
  const auth = await login(request, 'mcp-owner');
  const client = await connect(auth.token);
  const other = await connect((await login(request, 'mcp-other')).token);
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(
      [
        'list_tasks',
        'get_task',
        'create_task',
        'update_task',
        'complete_task',
        'delete_task',
        'list_lists',
        'create_list',
      ].sort(),
    );
    await client.ping();
    const list = await call(client, 'create_list', {
      mutationId: crypto.randomUUID(),
      name: 'Agent list',
    });
    const args = {
      mutationId: crypto.randomUUID(),
      title: 'Agent task',
      dueDate: '2026-10-31',
      plannedDate: '2026-10-20',
      listId: list.entity.id,
    };
    const created = await call(client, 'create_task', args);
    expect(created.entity.ownerId).toBe(auth.record.id);
    expect(created.entity.rank).toMatch(/^[0-9a-f]{32}$/);
    expect(await call(client, 'create_task', args)).toEqual(created);
    expect(
      (
        await client.callTool({
          name: 'create_task',
          arguments: { ...args, title: 'Changed retry' },
        })
      ).isError,
    ).toBe(true);
    expect((await call(other, 'list_tasks', {})).items).toEqual([]);
    expect(
      (await other.callTool({ name: 'get_task', arguments: { id: created.entity.id } })).isError,
    ).toBe(true);
    expect(
      (
        await other.callTool({
          name: 'delete_task',
          arguments: {
            id: created.entity.id,
            expectedRevision: created.revision,
            mutationId: crypto.randomUUID(),
          },
        })
      ).isError,
    ).toBe(true);
    expect((await call(client, 'list_lists', {})).items).toHaveLength(1);
    expect(
      (
        await call(client, 'list_tasks', {
          listId: list.entity.id,
          completed: false,
          query: 'Agent',
        })
      ).items,
    ).toHaveLength(1);
    for (const changes of [
      { dueDate: '2026-02-30' },
      { title: ' ' },
      { completed: 'yes' },
      { ownerId: 'other' },
      { listId: crypto.randomUUID() },
      {},
    ]) {
      expect(
        (
          await client.callTool({
            name: 'update_task',
            arguments: {
              id: created.entity.id,
              expectedRevision: created.revision,
              mutationId: crypto.randomUUID(),
              changes,
            },
          })
        ).isError,
      ).toBe(true);
    }
    const patch = {
      id: created.entity.id,
      expectedRevision: created.revision,
      mutationId: crypto.randomUUID(),
      changes: { title: 'Updated', dueDate: null },
    };
    const updated = await call(client, 'update_task', patch);
    expect(updated.entity.title).toBe('Updated');
    expect(updated.entity.dueDate).toBeNull();
    expect(updated.entity.plannedDate).toBe('2026-10-20');
    expect(await call(client, 'update_task', patch)).toEqual(updated);
    expect(
      (
        await client.callTool({
          name: 'complete_task',
          arguments: {
            id: created.entity.id,
            expectedRevision: created.revision,
            mutationId: crypto.randomUUID(),
          },
        })
      ).isError,
    ).toBe(true);
    const complete = await call(client, 'complete_task', {
      id: created.entity.id,
      expectedRevision: updated.revision,
      mutationId: crypto.randomUUID(),
    });
    expect(complete.entity.completed).toBe(true);
    const deleted = await call(client, 'delete_task', {
      id: created.entity.id,
      expectedRevision: complete.revision,
      mutationId: crypto.randomUUID(),
    });
    expect(deleted.entity.deletedAt).toBeGreaterThan(0);
    expect((await call(client, 'list_tasks', {})).items).toHaveLength(0);
    expect((await call(client, 'get_task', { id: created.entity.id })).entity.deletedAt).toBe(
      deleted.entity.deletedAt,
    );
    // Replaying a successful older command returns its original result, never recreates the tombstone.
    expect(await call(client, 'create_task', args)).toEqual(created);
    const pulled = await (
      await request.get('/api/todo/pull', { headers: { Authorization: auth.pbToken } })
    ).json();
    expect(pulled.changes).toHaveLength(5);
    expect(pulled.changes.at(-1).payload.deletedAt).toBe(deleted.entity.deletedAt);
  } finally {
    await client.close();
    await other.close();
  }
});

test('MCP HTTP boundary requires account auth, validates protocol/origin and rejects write notifications', async ({
  request,
}) => {
  const auth = await login(request, 'mcp-other');
  const headers = {
    Authorization: `Bearer ${auth.token}`,
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-11-25',
  };
  const data = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  expect((await request.post('/api/todo/mcp', { data })).status()).toBe(401);
  expect(
    (
      await request.post('/api/todo/mcp', {
        data,
        headers: { ...headers, Origin: 'https://attacker.invalid' },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post('/api/todo/mcp', { data, headers: { ...headers, Origin: 'null' } })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post('/api/todo/mcp', {
        data,
        headers: { ...headers, Origin: 'http://127.0.0.1:8091' },
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await request.post('/api/todo/mcp', {
        data,
        headers: { ...headers, 'MCP-Protocol-Version': 'invalid' },
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await request.post('/api/todo/mcp', {
        data,
        headers: { ...headers, Accept: 'application/json' },
      })
    ).status(),
  ).toBe(400);
  expect((await request.get('/api/todo/mcp', { headers })).status()).toBe(405);
  expect((await request.delete('/api/todo/mcp', { headers })).status()).toBe(405);
  expect((await request.post('/api/todo/mcp', { data: [data], headers })).status()).toBe(400);
  // The Go SDK rejects unsupported HTTP methods before JSON-RPC dispatch.
  const unknown = await request.post('/api/todo/mcp', {
    data: { ...data, method: 'missing' },
    headers,
  });
  expect(unknown.status()).toBe(400);
  expect(await unknown.text()).toContain('unsupported');
  expect(
    (
      await request.post('/api/todo/mcp', {
        data: {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'create_task',
            arguments: { mutationId: crypto.randomUUID(), title: 'Do not execute' },
          },
        },
        headers,
      })
    ).status(),
  ).toBe(400);
  const client = await connect(auth.token);
  try {
    expect((await call(client, 'list_tasks', {})).items).toEqual([]);
  } finally {
    await client.close();
  }
});

test('MCP changes reach a signed-in PWA, merge with offline edits and propagate deletions', async ({
  request,
  page,
  context,
}) => {
  const auth = await login(request, 'mcp-sync');
  const client = await connect(auth.token);
  try {
    await page.goto('/account');
    await page.getByLabel('E-Mail', { exact: true }).fill('mcp-sync@example.test');
    await page.getByLabel('Passwort', { exact: true }).fill('test-password-12345!');
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await expect(page.getByTestId('account-sync-status')).toHaveText('Synchronisiert');
    await page.getByRole('button', { name: /Alle Aufgaben/ }).click();
    const created = await call(client, 'create_task', {
      title: 'From MCP',
      mutationId: crypto.randomUUID(),
    });
    await expect(page.getByTestId('task-title')).toHaveText('From MCP');
    await context.setOffline(true);
    await page.getByTestId('task-title').click();
    await page.getByLabel('Titel bearbeiten', { exact: true }).fill('Offline client title');
    await page.getByLabel('Titel bearbeiten', { exact: true }).press('Tab');
    await expect(
      page
        .getByTestId('account-task')
        .filter({ has: page.getByLabel('Titel bearbeiten', { exact: true }) }),
    ).toHaveAttribute('aria-busy', 'false');
    await call(client, 'update_task', {
      id: created.entity.id,
      expectedRevision: created.revision,
      mutationId: crypto.randomUUID(),
      changes: { dueDate: '2026-12-24' },
    });
    await context.setOffline(false);
    await triggerSync(page);
    await expect(page.getByTestId('account-sync-status')).toHaveText('Synchronisiert');
    const merged = await call(client, 'get_task', { id: created.entity.id });
    expect(merged.entity.title).toBe('Offline client title');
    expect(merged.entity.dueDate).toBe('2026-12-24');
    await expect(page.getByLabel('Fällig am bearbeiten', { exact: true })).toHaveAttribute(
      'data-date',
      '2026-12-24',
    );
    await call(client, 'delete_task', {
      id: created.entity.id,
      expectedRevision: merged.entity.remoteRevision,
      mutationId: crypto.randomUUID(),
    });
    await expect(page.getByTestId('account-task')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('account-sync-status')).toHaveText('Synchronisiert');
    await expect(page.getByTestId('account-task')).toHaveCount(0);
  } finally {
    await client.close();
  }
});

test('MCP concurrent retries commit once; competing revisions conflict; pagination stays owner-scoped', async ({
  request,
}) => {
  const auth = await login(request, 'mcp-race');
  const client = await connect(auth.token);
  try {
    const args = { title: 'Exactly once', mutationId: crypto.randomUUID() };
    const [a, b] = await Promise.all([
      call(client, 'create_task', args),
      call(client, 'create_task', args),
    ]);
    expect(a).toEqual(b);
    const competing = await Promise.all(
      ['First edit', 'Second edit'].map((title) =>
        client.callTool({
          name: 'update_task',
          arguments: {
            id: a.entity.id,
            expectedRevision: a.revision,
            mutationId: crypto.randomUUID(),
            changes: { title },
          },
        }),
      ),
    );
    expect(competing.filter((result) => !result.isError)).toHaveLength(1);
    expect(competing.filter((result) => result.isError)).toHaveLength(1);
    const c = await call(client, 'create_task', {
      title: 'Second task',
      mutationId: crypto.randomUUID(),
    });
    const d = await call(client, 'create_task', {
      title: 'Third task',
      mutationId: crypto.randomUUID(),
    });
    expect(a.entity.rank! < c.entity.rank! && c.entity.rank! < d.entity.rank!).toBe(true);
    const first = await call(client, 'list_tasks', { limit: 2 });
    const last = await call(client, 'list_tasks', { limit: 2, cursor: first.nextCursor });
    expect(first.items).toHaveLength(2);
    expect(last.items).toHaveLength(1);
    expect(last.nextCursor).toBeNull();
    expect(new Set([...first.items, ...last.items].map((item) => item.id)).size).toBe(3);
    const pull = await (
      await request.get('/api/todo/pull', { headers: { Authorization: auth.pbToken } })
    ).json();
    expect(pull.changes).toHaveLength(4);
  } finally {
    await client.close();
  }
});
