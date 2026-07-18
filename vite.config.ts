import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import Icons from 'unplugin-icons/vite';

// Tauri sets TAURI_ENV_* for its beforeBuildCommand (`pnpm build`), so a build
// driven by `tauri build/dev` is detectable here at config time. The Tauri shell
// bundles its assets and is offline already, so it needs no service worker.
const isTauri = !!process.env.TAURI_ENV_PLATFORM;

// https://vite.dev/config/
export default defineConfig({
	// Compile-time flag so Tauri-only branches tree-shake out of the web build
	// (and vice versa). Typed in src/globals.d.ts.
	define: {
		__TAURI__: JSON.stringify(isTauri),
	},
	plugins: [
		svelte(),
		// Lucide icons compiled to Svelte components, imported as `~icons/lucide/*`.
		Icons({ compiler: 'svelte' }),
		// Offline shell for the production web build (served by PocketBase).
		// Workbox precaches every built asset — including the lazy ?quickadd
		// chunk — so the app loads with the server down. autoUpdate keeps the
		// shell fresh across deploys. Registration is manual (see main.ts) so it
		// never runs in the Tauri shell; the API (/api/) and admin (/_/) are
		// excluded from the SPA navigation fallback and so never cached.
		VitePWA({
			// No SW in the Tauri bundle at all; the virtual:pwa-register import
			// in main.ts still resolves (to a no-op) so the build succeeds.
			disable: isTauri,
			registerType: 'autoUpdate',
			injectRegister: false,
			manifest: false,
			workbox: {
				// Default globs cover js/css/html; add svg so the favicon is
				// cached too (the whole shell works offline, no failed fetch).
				globPatterns: ['**/*.{js,css,html,svg}'],
				navigateFallback: 'index.html',
				navigateFallbackDenylist: [/^\/api\//, /^\/_\//],
			},
		}),
	],
});
