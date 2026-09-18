import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

test('fresh PocketBase start never invokes an OS browser opener', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'todo-no-browser-'));
  const bin = join(directory, 'bin'),
    marker = join(directory, 'browser-opened');
  await mkdir(bin);
  for (const executable of ['open', 'xdg-open'])
    await writeFile(
      join(bin, executable),
      '#!/bin/sh\nprintf called > "$TODO_BROWSER_OPEN_MARKER"\n',
      { mode: 0o755 },
    );
  const child = spawn(
    resolve('.tools/freiraum'),
    ['serve', '--http=127.0.0.1:8092', `--dir=${join(directory, 'data')}`],
    {
      env: {
        ...process.env,
        TODO_PUBLIC_URL: 'http://127.0.0.1:8092',
        PATH: `${bin}:${process.env.PATH}`,
        TODO_BROWSER_OPEN_MARKER: marker,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        ready = (await fetch('http://127.0.0.1:8092/api/health')).ok;
      } catch {
        /* Startup still running. */
      }
      if (ready || child.exitCode !== null) break;
      await delay(50);
    }
    expect(ready, 'PocketBase must start successfully').toBe(true);
    await delay(500);
    const browserOpened = await access(marker).then(
      () => true,
      () => false,
    );
    expect(browserOpened, 'Startup invoked open/xdg-open').toBe(false);
    expect(output).not.toContain('/pbinstall/');
  } finally {
    child.kill('SIGTERM');
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
});
