import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const suffix = `${process.pid}-${Date.now()}`;
const image = `freiraum-smoke:${suffix}`;
const container = `freiraum-smoke-${suffix}`;
const volume = `freiraum-smoke-${suffix}`;
const port = 18_000 + (process.pid % 1_000);
const origin = `http://127.0.0.1:${port}`;
const key = '0123456789abcdef0123456789abcdef';
const password = 'container-smoke-password';

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

function start() {
  command([
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
  ]);
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

async function login() {
  const response = await fetch(`${origin}/api/collections/todo_users/auth-with-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identity: 'smoke@example.test', password }),
  });
  if (!response.ok) throw new Error(`login failed (${response.status})`);
  return response.json();
}

try {
  command(['build', '--tag', image, '.']);

  const user = command(['image', 'inspect', image, '--format', '{{.Config.User}}'], {
    capture: true,
  }).stdout.trim();
  if (user !== '10001:10001') throw new Error(`unexpected runtime user ${user}`);

  for (const env of [
    [],
    ['--env', 'TODO_PUBLIC_URL=https://tasks.example.com/', '--env', `PB_ENCRYPTION_KEY=${key}`],
    ['--env', 'TODO_PUBLIC_URL=https://tasks.example.com', '--env', 'PB_ENCRYPTION_KEY=short'],
  ]) {
    const failed = command(['run', '--rm', ...env, image], { allowFailure: true, capture: true });
    if (failed.status === 0) throw new Error('container accepted invalid production configuration');
  }

  command(['volume', 'create', volume]);
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
    `${volume}:/app/pb_data`,
    image,
    'user-create',
    'smoke@example.test',
    '--dir=/app/pb_data',
    '--encryptionEnv=PB_ENCRYPTION_KEY',
  ]);

  start();
  await waitFor(
    async () => (await fetch(`${origin}/api/health`)).ok,
    'health endpoint unavailable',
  );

  const html = await (await fetch(`${origin}/`)).text();
  if (!html.includes('<html lang="de">') || !html.includes('/_app/immutable/entry/start.'))
    throw new Error('app shell was not served');
  const manifest = await (await fetch(`${origin}/manifest.webmanifest`)).json();
  if (manifest.name !== 'Freiraum') throw new Error('manifest was not served');
  const discovery = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
  if (discovery.issuer !== origin) throw new Error('OAuth discovery uses the wrong issuer');

  const cors = await fetch(`${origin}/api/health`, { headers: { Origin: origin } });
  if (cors.headers.get('access-control-allow-origin') !== origin)
    throw new Error('configured CORS origin was not returned');
  const foreignCors = await fetch(`${origin}/api/health`, {
    headers: { Origin: 'https://attacker.invalid' },
  });
  if (foreignCors.headers.has('access-control-allow-origin'))
    throw new Error('foreign CORS origin was allowed');

  const auth = await login();
  const reset = await fetch(`${origin}/api/todo/pull`, {
    headers: { authorization: auth.token },
  });
  if (!reset.ok) throw new Error(`initial reset pull failed (${reset.status})`);
  const { mode, generation } = await reset.json();
  if (mode !== 'reset' || typeof generation !== 'string' || generation.length === 0)
    throw new Error('initial pull did not provide a sync generation reset');
  const entityId = randomUUID();
  const mutationDeviceId = randomUUID();
  const mutation = {
    id: randomUUID(),
    entityId,
    entityType: 'task',
    entityVersion: 1,
    operation: 'create',
    deviceId: mutationDeviceId,
    baseRevision: 0,
    payload: {
      id: entityId,
      ownerId: auth.record.id,
      title: 'Container persistence smoke test',
      completed: false,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      fieldVersions: {
        title: { counter: 1, deviceId: mutationDeviceId },
        completed: { counter: 1, deviceId: mutationDeviceId },
        deletedAt: { counter: 0, deviceId: '' },
      },
    },
  };
  const pushed = await fetch(`${origin}/api/todo/push`, {
    method: 'POST',
    headers: {
      authorization: auth.token,
      'content-type': 'application/json',
      'X-Todo-Sync-Generation': generation,
    },
    body: JSON.stringify(mutation),
  });
  if (!pushed.ok) throw new Error(`task push failed (${pushed.status})`);

  command(['rm', '--force', container]);
  start();
  await waitFor(
    async () => (await fetch(`${origin}/api/health`)).ok,
    'restarted health unavailable',
  );
  const restartedAuth = await login();
  const pull = await fetch(`${origin}/api/todo/pull?generation=${encodeURIComponent(generation)}`, {
    headers: { authorization: restartedAuth.token },
  });
  if (!pull.ok) throw new Error(`pull after restart failed (${pull.status})`);
  const page = await pull.json();
  if (!page.changes.some((change) => change.entityId === entityId))
    throw new Error('task did not survive container restart');

  await waitFor(() => {
    const status = command(
      ['inspect', container, '--format', '{{if .State.Health}}{{.State.Health.Status}}{{end}}'],
      { capture: true },
    ).stdout.trim();
    return status === 'healthy';
  }, 'Docker healthcheck did not become healthy');

  for (let attempt = 1; attempt <= 31; attempt++) {
    const response = await fetch(`${origin}/api/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (attempt <= 30 && ![400, 422].includes(response.status))
      throw new Error(
        `OAuth registration rate limit triggered early on request ${attempt} (${response.status})`,
      );
    if (attempt === 31 && response.status !== 429)
      throw new Error(`OAuth registration rate limit missing (${response.status})`);
  }

  console.log('Container smoke test passed.');
} finally {
  command(['rm', '--force', container], { allowFailure: true, capture: true });
  command(['volume', 'rm', '--force', volume], { allowFailure: true, capture: true });
  command(['image', 'rm', '--force', image], { allowFailure: true, capture: true });
}
