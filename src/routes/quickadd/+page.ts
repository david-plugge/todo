// The Tauri quick-add window loads this as a real file (build/quickadd.html), so
// prerender it. It's a client-only capture UI (ssr is off app-wide), so the
// prerendered output is just the shell that boots straight into QuickAdd.
export const prerender = true;
