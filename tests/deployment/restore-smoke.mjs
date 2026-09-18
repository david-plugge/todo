import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const suffix = `${process.pid}-${Date.now()}`;
const image = `freiraum-restore-smoke:${suffix}`;
const oldContainer = `freiraum-restore-old-${suffix}`;
const restoredContainer = `freiraum-restore-new-${suffix}`;
const exportContainer = `freiraum-restore-export-${suffix}`;
const oldVolume = `freiraum-restore-old-${suffix}`;
const restoredVolume = `freiraum-restore-new-${suffix}`;
const port = 19_000 + (process.pid % 500);
const origin = `http://127.0.0.1:${port}`;
const key = '0123456789abcdef0123456789abcdef';
const email = 'restore-smoke@example.test';
const password = 'restore-smoke-password';
const backupName = 'restore-smoke.zip';
const restoreId = randomUUID();
const temporary = await mkdtemp(join(tmpdir(), 'freiraum-restore-smoke-'));
const exportedBackup = join(temporary, 'backup.zip');

function command(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (!options.allowFailure && result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout}\n${result.stderr}` : '';
    throw new Error(`docker ${args.join(' ')} failed (${result.status})${detail}`);
  }
  return result;
}

function runtimeArgs(container, volume) {
  return [
    'run',
    '--detach',
    '--name',
    container,
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--publish',
    `127.0.0.1:${port}:8090`,
    '--env',
    `TODO_PUBLIC_URL=${origin}`,
    '--env',
    `PB_ENCRYPTION_KEY=${key}`,
    '--volume',
    `${volume}:/app/pb_data`,
    image,
  ];
}

function start(container, volume) {
  command(runtimeArgs(container, volume));
}

function stop(container) {
  command(['rm', '--force', container], { allowFailure: true, capture: true });
}

async function waitFor(check, message, timeout = 45_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      if (await check()) return;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${message}${last ? `: ${last}` : ''}`);
}

async function waitForServer(message) {
  await waitFor(async () => (await fetch(`${origin}/api/health`)).ok, message);
}

async function login() {
  const response = await fetch(`${origin}/api/collections/todo_users/auth-with-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identity: email, password }),
  });
  if (!response.ok) throw new Error(`login failed (${response.status})`);
  return response.json();
}

async function bootstrap(token) {
  const response = await fetch(`${origin}/api/todo/pull`, {
    headers: { authorization: token },
  });
  if (!response.ok) throw new Error(`generation bootstrap failed (${response.status})`);
  const reset = await response.json();
  if (
    reset.mode !== 'reset' ||
    typeof reset.generation !== 'string' ||
    reset.generation.length === 0 ||
    !Number.isSafeInteger(reset.until)
  )
    throw new Error('generation bootstrap did not return a valid reset');
  return reset;
}

async function pushTask(auth, generation, title, entityId = randomUUID()) {
  const deviceId = randomUUID();
  const mutation = {
    id: randomUUID(),
    entityId,
    entityType: 'task',
    entityVersion: 1,
    operation: 'create',
    deviceId,
    baseRevision: 0,
    payload: {
      id: entityId,
      ownerId: auth.record.id,
      title,
      completed: false,
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      fieldVersions: {
        title: { counter: 1, deviceId },
        completed: { counter: 1, deviceId },
        deletedAt: { counter: 0, deviceId: '' },
      },
    },
  };
  const response = await fetch(`${origin}/api/todo/push`, {
    method: 'POST',
    headers: {
      authorization: auth.token,
      'content-type': 'application/json',
      'X-Todo-Sync-Generation': generation,
    },
    body: JSON.stringify(mutation),
  });
  if (!response.ok)
    throw new Error(`push ${title} failed (${response.status}): ${await response.text()}`);
  return entityId;
}

async function taskIds(token) {
  const response = await fetch(`${origin}/api/collections/tasks/records?perPage=100`, {
    headers: { authorization: token },
  });
  if (!response.ok) throw new Error(`task listing failed (${response.status})`);
  const page = await response.json();
  return new Set(page.items.map((item) => item.data.id));
}

try {
  await chmod(temporary, 0o755);
  command(['build', '--tag', image, '.']);
  command(['volume', 'create', oldVolume]);
  command(['volume', 'create', restoredVolume]);

  command([
    'run',
    '--rm',
    '--entrypoint',
    '/app/freiraum',
    '--env',
    `PB_ENCRYPTION_KEY=${key}`,
    '--env',
    `TODO_USER_PASSWORD=${password}`,
    '--volume',
    `${oldVolume}:/app/pb_data`,
    image,
    'user-create',
    email,
    '--dir=/app/pb_data',
    '--encryptionEnv=PB_ENCRYPTION_KEY',
  ]);

  start(oldContainer, oldVolume);
  await waitForServer('old server did not start');
  const oldAuth = await login();
  const oldReset = await bootstrap(oldAuth.token);
  const taskA = await pushTask(oldAuth, oldReset.generation, 'Task A');
  stop(oldContainer);

  command([
    'run',
    '--rm',
    '--entrypoint',
    '/app/freiraum',
    '--env',
    `PB_ENCRYPTION_KEY=${key}`,
    '--volume',
    `${oldVolume}:/app/pb_data`,
    image,
    'backup-create',
    backupName,
    '--dir=/app/pb_data',
    '--encryptionEnv=PB_ENCRYPTION_KEY',
  ]);

  start(oldContainer, oldVolume);
  await waitForServer('old server did not restart after backup');
  const taskB = await pushTask(oldAuth, oldReset.generation, 'Task B');
  stop(oldContainer);

  command(['create', '--name', exportContainer, '--volume', `${oldVolume}:/app/pb_data`, image], {
    capture: true,
  });
  command(['cp', `${exportContainer}:/app/pb_data/backups/${backupName}`, exportedBackup]);
  stop(exportContainer);

  command([
    'run',
    '--rm',
    '--entrypoint',
    '/app/freiraum',
    '--volume',
    `${restoredVolume}:/app/pb_data`,
    '--volume',
    `${temporary}:/restore-input:ro`,
    image,
    'restore-new',
    '--backup=/restore-input/backup.zip',
    '--target=/app/pb_data',
    `--restore-id=${restoreId}`,
  ]);

  const pendingStart = command(
    [
      'run',
      '--rm',
      '--read-only',
      '--tmpfs',
      '/tmp',
      '--env',
      `TODO_PUBLIC_URL=${origin}`,
      '--env',
      `PB_ENCRYPTION_KEY=${key}`,
      '--volume',
      `${restoredVolume}:/app/pb_data`,
      image,
    ],
    { allowFailure: true, capture: true },
  );
  if (
    pendingStart.status === 0 ||
    !`${pendingStart.stdout}\n${pendingStart.stderr}`.includes('restore is pending')
  )
    throw new Error('normal start did not fail on the pending restore marker');

  command([
    'run',
    '--rm',
    '--entrypoint',
    '/app/freiraum',
    '--env',
    `PB_ENCRYPTION_KEY=${key}`,
    '--volume',
    `${restoredVolume}:/app/pb_data`,
    image,
    'restore-finalize',
    '--dir=/app/pb_data',
    `--restore-id=${restoreId}`,
    '--encryptionEnv=PB_ENCRYPTION_KEY',
  ]);

  start(restoredContainer, restoredVolume);
  await waitForServer('restored server did not start');
  const staleToken = await fetch(`${origin}/api/todo/pull`, {
    headers: { authorization: oldAuth.token },
  });
  if (staleToken.status !== 401)
    throw new Error(`pre-restore token remained valid (${staleToken.status})`);

  const restoredAuth = await login();
  const restoredReset = await bootstrap(restoredAuth.token);
  if (restoredReset.generation === oldReset.generation)
    throw new Error('restore finalization did not rotate the sync generation');
  const restoredIds = await taskIds(restoredAuth.token);
  if (!restoredIds.has(taskA)) throw new Error('Task A from the backup is missing after restore');
  if (restoredIds.has(taskB)) throw new Error('post-backup Task B unexpectedly survived restore');

  const taskC = await pushTask(restoredAuth, restoredReset.generation, 'Task C');
  const changes = await fetch(
    `${origin}/api/todo/pull?generation=${encodeURIComponent(restoredReset.generation)}`,
    { headers: { authorization: restoredAuth.token } },
  );
  if (!changes.ok) throw new Error(`changes pull after restore failed (${changes.status})`);
  const changesPage = await changes.json();
  if (
    changesPage.mode !== 'changes' ||
    !changesPage.changes.some((change) => change.entityId === taskC)
  )
    throw new Error('restored server did not expose the post-restore push via changes pull');

  stop(restoredContainer);
  start(restoredContainer, restoredVolume);
  await waitForServer('restored server did not restart');
  const restartedAuth = await login();
  const restartedIds = await taskIds(restartedAuth.token);
  if (!restartedIds.has(taskA) || !restartedIds.has(taskC) || restartedIds.has(taskB))
    throw new Error('restored task set did not persist across restart');

  console.log('Restore smoke test passed.');
} finally {
  stop(oldContainer);
  stop(restoredContainer);
  stop(exportContainer);
  command(['volume', 'rm', '--force', oldVolume], { allowFailure: true, capture: true });
  command(['volume', 'rm', '--force', restoredVolume], { allowFailure: true, capture: true });
  command(['image', 'rm', '--force', image], { allowFailure: true, capture: true });
  await rm(temporary, { recursive: true, force: true });
}
