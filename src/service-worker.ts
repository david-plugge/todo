/// <reference lib="webworker" />
import { build, files, version } from '$service-worker';
const sw = self as unknown as ServiceWorkerGlobalScope;
const cacheName = `todo-shell-${version}`;
const shell = [...build, ...files, '/'];
sw.addEventListener('install', (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(shell)));
});
sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith('todo-shell-') && key !== cacheName) await caches.delete(key);
      await sw.clients.claim();
    })(),
  );
});
sw.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== sw.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/_/')
  )
    return;
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(
        async () =>
          (await (await caches.open(cacheName)).match('/', { ignoreVary: true })) ??
          Response.error(),
      ),
    );
  } else if (shell.includes(url.pathname)) {
    // PocketBase adds Vary: Origin. Precache and module requests differ in Origin,
    // but these allowlisted same-origin build assets are identical for every user.
    event.respondWith(
      caches
        .open(cacheName)
        .then(
          async (cache) =>
            (await cache.match(event.request, { ignoreVary: true })) ?? fetch(event.request),
        ),
    );
  }
});
