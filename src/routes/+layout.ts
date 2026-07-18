// Offline-first, auth-gated client app: all data lives in IndexedDB behind
// login, so there is nothing to render on the server. Ship a pure SPA.
export const ssr = false;

export const prerender = true;
