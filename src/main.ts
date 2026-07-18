import { mount } from 'svelte';
import { registerSW } from 'virtual:pwa-register';
import './app.css';
import App from './App.svelte';
import QuickAdd from './lib/QuickAdd.svelte';
import { isTauri } from './lib/platform';

// The Tauri global hotkey opens a dedicated window at ?quickadd — mount the
// lightweight capture UI there, and the full app everywhere else.
const isQuickAdd = new URLSearchParams(location.search).has('quickadd');
const target = document.getElementById('app')!;

const app = isQuickAdd ? mount(QuickAdd, { target }) : mount(App, { target });

// Register the Workbox offline service worker only for the production web build
// served by PocketBase — not the Tauri shell (already offline) or the vite dev
// server. autoUpdate reloads to the fresh shell when a new deploy is detected.
if (import.meta.env.PROD && !isTauri) {
	registerSW({ immediate: true });
}

export default app;
