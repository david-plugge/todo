import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
export default {
	preprocess: vitePreprocess(),
	kit: {
		// Client-only SPA: PocketBase (prod) and the Tauri shell both serve static
		// files, so there's no server to render on. `fallback` emits a single
		// index.html shell that boots the client router for any path — matching
		// PocketBase's --indexFallback and Tauri's asset loader.
		adapter: adapter({ fallback: 'index.html' }),
		// We register the service worker ourselves (main app only, never the Tauri
		// shell) — see src/routes/+layout.svelte.
		serviceWorker: { register: false },
	},
};
