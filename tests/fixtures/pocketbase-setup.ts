import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { expect } from '@playwright/test';
import { once } from 'node:events';
import { createServer } from 'node:net';
/** A port the operating system just handed out cannot host a foreign suite. */
async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as { port: number };
  await new Promise((done) => probe.close(done));
  return port;
}
export default async function setup() {
  const address = `http://127.0.0.1:${await freePort()}`;
  const serving = async () => {
    try {
      return (await fetch(`${address}/api/health`, { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
      return false;
    }
  };
  const temporary = await mkdtemp(join(tmpdir(), 'todo-pocketbase-'));
  const binary = resolve('.tools/todo');
  const names = [
    'oauth-user',
    'mcp-race',
    'mcp-owner',
    'mcp-other',
    'mcp-sync',
    'api-owner',
    'api-other',
    'paging',
    'conflict',
    'ui-owner',
    'ui-other',
    'offline',
    'field-api',
    'ranking-ab',
    'ranking-ba',
    'ranking-api',
    'mobile-ui',
    'list-actions',
    'list-actions-delete-tasks',
    'list-actions-mobile',
    'list-actions-inline',
    'task-groups',
    'live-edit',
    'task-collapsible',
    'recurrence',
    'pointer-drag',
    'list-drop',
    'touch-drag',
    'task-notes',
    ...['different', 'same', 'delete'].flatMap((kind) => [kind + '-ab', kind + '-ba']),
  ];
  let child: ChildProcess | undefined;
  let exited: Promise<unknown> | undefined;
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
    delete process.env.TODO_TEST_ADDRESS;
    await rm(temporary, { recursive: true, force: true });
  };
  try {
    for (const name of names) {
      const result = spawnSync(
        binary,
        ['user-create', name + '@example.test', `--dir=${temporary}`],
        {
          env: { ...process.env, TODO_USER_PASSWORD: 'test-password-12345!' },
          encoding: 'utf8',
        },
      );
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    }
    const server = spawn(
      binary,
      [
        'serve',
        '--dev',
        `--http=${new URL(address).host}`,
        `--dir=${temporary}`,
        `--publicDir=${resolve('pb_public')}`,
      ],
      {
        stdio: 'inherit',
        env: { ...process.env, TODO_PUBLIC_URL: address },
      },
    );
    child = server;
    exited = once(server, 'exit');
    // Workers read the config again in their own process and inherit this value.
    process.env.TODO_TEST_ADDRESS = address;
    await expect
      .poll(
        async () => {
          if (server.exitCode !== null) throw new Error('Test backend stopped during startup');
          return await serving();
        },
        { timeout: 10000 },
      )
      .toBe(true);
    return stop;
  } catch (error) {
    await stop();
    throw error;
  }
}
