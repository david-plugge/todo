import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { expect } from '@playwright/test';
import { once } from 'node:events';
export default async function setup() {
  const temporary = await mkdtemp(join(tmpdir(), 'todo-pocketbase-'));
  const binary = resolve('.tools/freiraum');
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
    ...['different', 'same', 'delete'].flatMap((kind) => [kind + '-ab', kind + '-ba']),
  ];
  let child: ChildProcess | undefined;
  let exited: Promise<unknown> | undefined;
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
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
        '--http=127.0.0.1:8091',
        `--dir=${temporary}`,
        `--publicDir=${resolve('pb_public')}`,
      ],
      {
        stdio: 'inherit',
        env: { ...process.env, TODO_PUBLIC_URL: 'http://127.0.0.1:8091' },
      },
    );
    child = server;
    exited = once(server, 'exit');
    await expect
      .poll(
        async () => {
          if (server.exitCode !== null) throw new Error('Test backend stopped during startup');
          try {
            return (await fetch('http://127.0.0.1:8091/api/health')).ok;
          } catch {
            return false;
          }
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
