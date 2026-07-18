// True when actually running inside the Tauri webview.
//
// In dev a single vite server can be opened by BOTH the Tauri webview and a
// plain browser (`pnpm tauri dev` also serves localhost:5173), so the build-env
// `__TAURI__` constant can't tell them apart — we ask at runtime instead. In a
// production build the web and Tauri bundles are separate artifacts that only
// ever load in their own runtime, so the static `__TAURI__` constant is accurate
// and lets the unused branch (and any Tauri-only code behind it) tree-shake.
export const isTauri: boolean = import.meta.env.DEV ? '__TAURI_INTERNALS__' in window : __TAURI__;
