import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// The SPA talks to its own origin, so the dev server forwards the backend paths to a
// locally running PocketBase. Only `pnpm run backend` serves them; nothing is mocked.
const backend = process.env.TODO_BACKEND_URL ?? 'http://127.0.0.1:8090';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    proxy: {
      '/api': { target: backend, changeOrigin: false },
      '/.well-known': { target: backend, changeOrigin: false },
    },
  },
});
