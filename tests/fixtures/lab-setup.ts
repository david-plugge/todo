// Real HTTP fixture for crash, offline and delayed-ACK tests. Owned by Playwright.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
type Payload = Record<string, unknown> & { id: string; version: number };
type Mutation = Record<string, unknown> & {
  id: string;
  entityId: string;
  entityType: string;
  entityVersion: number;
  operation: string;
  payload: Payload;
};
type Ack = Pick<Mutation, 'entityId' | 'entityType' | 'entityVersion'> & { mutationId: string };
interface Session {
  records: Map<string, Payload>;
  mutations: Map<string, Mutation>;
  requests: Mutation[];
  waiting: { response: ServerResponse; ack: Ack }[];
  pauseAck: boolean;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export default async function setup() {
  const root = resolve('.test-build/harness');
  const sessions = new Map<string, Session>();
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };
  function json(response: ServerResponse, status: number, value: unknown) {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(value));
  }
  async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
    let text = '';
    for await (const chunk of request) {
      text += chunk;
      if (text.length > 1_000_000) throw new Error('Request too large');
    }
    const value: unknown = JSON.parse(text);
    if (!isObject(value)) throw new Error('Expected JSON object');
    return value;
  }
  function getSession(request: IncomingMessage): Session {
    const id = request.headers['x-spike-session'];
    if (typeof id !== 'string' || !/^[a-z0-9-]{36}$/.test(id))
      throw new Error('Missing lab session');
    let session = sessions.get(id);
    if (!session) {
      session = {
        records: new Map(),
        mutations: new Map(),
        requests: [],
        waiting: [],
        pauseAck: false,
      };
      sessions.set(id, session);
    }
    return session;
  }
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (path.startsWith('/api/spike/')) {
        const session = getSession(request);
        if (path === '/api/spike/control' && request.method === 'POST') {
          const control = await body(request);
          session.pauseAck = control.pauseAck === true;
          if (!session.pauseAck)
            for (const pending of session.waiting.splice(0))
              json(pending.response, 200, pending.ack);
          return json(response, 200, { ok: true });
        }
        if (path === '/api/spike/state' && request.method === 'GET')
          return json(response, 200, {
            records: [...session.records.values()],
            mutationCount: session.mutations.size,
            requests: session.requests,
            waiting: session.waiting.length,
          });
        if (path === '/api/spike/push' && request.method === 'POST') {
          const input = await body(request);
          const { id, entityId, entityType, entityVersion, operation, payload } = input;
          if (
            typeof id !== 'string' ||
            typeof entityId !== 'string' ||
            typeof entityType !== 'string' ||
            !['task', 'list'].includes(entityType) ||
            typeof entityVersion !== 'number' ||
            !Number.isSafeInteger(entityVersion) ||
            entityVersion < 1 ||
            typeof operation !== 'string' ||
            !['create', 'update', 'delete'].includes(operation) ||
            !isObject(payload) ||
            payload.id !== entityId ||
            payload.version !== entityVersion
          )
            return json(response, 400, { error: 'Invalid mutation' });
          const typedPayload: Payload = { ...payload, id: entityId, version: entityVersion };
          const mutation: Mutation = {
            ...input,
            id,
            entityId,
            entityType,
            entityVersion,
            operation,
            payload: typedPayload,
          };
          session.requests.push(mutation);
          const previous = session.mutations.get(id);
          if (previous && JSON.stringify(previous) !== JSON.stringify(mutation))
            return json(response, 409, { error: 'Idempotency key reused' });
          session.mutations.set(id, mutation);
          const key = `${entityType}/${entityId}`;
          const current = session.records.get(key);
          // Single-device lab only; this is NOT the future field-level merge algorithm.
          if (!current || current.version < entityVersion) session.records.set(key, typedPayload);
          const ack = { mutationId: id, entityId, entityType, entityVersion };
          if (!session.pauseAck) return json(response, 200, ack);
          const pending = { response, ack };
          session.waiting.push(pending);
          response.on('close', () => {
            session.waiting = session.waiting.filter((item) => item !== pending);
          });
          return;
        }
        return json(response, 404, { error: 'Unknown fixture endpoint' });
      }
      if (path.startsWith('/api/') || path.startsWith('/_/'))
        return json(response, 404, { error: 'No PocketBase in this fixture' });
      if (!['GET', 'HEAD'].includes(request.method ?? ''))
        return json(response, 405, { error: 'Method not allowed' });
      let file = resolve(root, `.${decodeURIComponent(path)}`);
      if (file !== root && !file.startsWith(root + sep))
        return json(response, 403, { error: 'Outside build directory' });
      try {
        if (!(await stat(file)).isFile()) file = resolve(root, 'index.html');
      } catch {
        if (extname(path)) return json(response, 404, { error: 'Missing asset' });
        file = resolve(root, 'index.html');
      }
      const data = await readFile(file);
      response.writeHead(200, {
        'content-type': types[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (!response.headersSent)
        json(response, 400, { error: error instanceof Error ? error.message : 'Bad request' });
      else response.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(4173, '127.0.0.1', resolve);
  });
  return async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
}
