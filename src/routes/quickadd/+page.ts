// Static overlay page (no dynamic params): prerender it to a real static file
// so the Tauri asset loader can serve /quickadd directly, without the SPA
// fallback. Covered by the default `entries: ["*"]` (param-free routes).
export const prerender = true;
