/// <reference types="unplugin-icons/types/svelte" />

// Compile-time constants injected by Vite's `define` (see vite.config.ts).

/** True when the bundle is built by Tauri (`tauri build`/`dev`), false for the
 *  plain web build. Set from `TAURI_ENV_PLATFORM` at config time, so Tauri-only
 *  and web-only branches are dead-code-eliminated in the other target. */
declare const __TAURI__: boolean;
