import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import Icons from 'unplugin-icons/vite';

// Tauri sets TAURI_ENV_* for its beforeBuildCommand (`pnpm build`), so a build
// driven by `tauri build/dev` is detectable here at config time. The Tauri shell
// bundles its assets and is offline already, so it needs no service worker.
const isTauri = !!process.env.TAURI_ENV_PLATFORM;

// https://vite.dev/config/
export default defineConfig({
	// Compile-time flag so Tauri-only branches tree-shake out of the web build
	// (and vice versa). Typed in src/globals.d.ts.
	define: { __TAURI__: JSON.stringify(isTauri) },
	plugins: [
		tailwindcss(),
		sveltekit(),
		// Lucide icons compiled to Svelte components, imported as `~icons/lucide/*`.
		Icons({ compiler: 'svelte' }),
	],
	// Tauri expects a fixed dev port; fail rather than silently pick another.
	server: { port: 5173, strictPort: true },
	clearScreen: false,
});
