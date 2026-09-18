import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const types: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function send(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

/** Serves exactly the production static build, without fixture API endpoints. */
export default async function setup() {
  const root = resolve('pb_public');
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (!['GET', 'HEAD'].includes(request.method ?? ''))
        return send(response, 405, { error: 'Method not allowed' });
      let file = resolve(root, `.${decodeURIComponent(path)}`);
      if (file !== root && !file.startsWith(root + sep))
        return send(response, 403, { error: 'Outside build directory' });
      try {
        if (!(await stat(file)).isFile()) file = resolve(root, 'index.html');
      } catch {
        if (extname(path)) return send(response, 404, { error: 'Missing asset' });
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
        send(response, 400, { error: error instanceof Error ? error.message : 'Bad request' });
      else response.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(4174, '127.0.0.1', resolve);
  });
  return async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
}
