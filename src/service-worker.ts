/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

// `self` is the ServiceWorkerGlobalScope in this module.
const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `cache-${version}`;

// The SPA shell that boots the client router for any path. adapter-static serves
// it as index.html; we cache it under "/" and replay it for offline navigations
// (this is the old Workbox `navigateFallback: index.html`, done by hand).
const SHELL = '/';

// Everything to precache: hashed app chunks + static files + the shell.
const ASSETS = [...build, ...files, SHELL];

sw.addEventListener('install', (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
	// Take over as soon as the new build is cached (mirrors the old autoUpdate).
	sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
	// Drop caches from previous versions, then control open pages immediately.
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => sw.clients.claim()),
	);
});

sw.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);

	// Cross-origin (e.g. a remote sync server): always go to the network.
	if (url.origin !== location.origin) return;

	// Never intercept the PocketBase API or admin UI — sync and auth must hit the
	// network directly (and fail honestly when offline).
	if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/_/')) return;

	event.respondWith(respond(request, url));
});

async function respond(request: Request, url: URL): Promise<Response> {
	const cache = await caches.open(CACHE);

	// Hashed build assets are immutable — serve straight from cache.
	if (ASSETS.includes(url.pathname)) {
		const cached = await cache.match(url.pathname);
		if (cached) return cached;
	}

	// Otherwise network-first, falling back to the cached shell so a full reload
	// still boots the SPA offline.
	try {
		return await fetch(request);
	} catch (err) {
		if (request.mode === 'navigate') {
			const shell = await cache.match(SHELL);
			if (shell) return shell;
		}
		const cached = await cache.match(url.pathname);
		if (cached) return cached;
		throw err;
	}
}
