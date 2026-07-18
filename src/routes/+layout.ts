// Offline-first, auth-gated client app: all data lives in IndexedDB behind
// login, so there is nothing to render on the server. Ship a pure SPA.
export const ssr = false;

// Dynamic routes (`[view=view]`, `project/[id]`) can't be crawled/prerendered,
// so they're served by the index.html fallback at runtime. Genuinely static
// pages opt into prerendering individually (see quickadd/+page.ts).
export const prerender = false;
