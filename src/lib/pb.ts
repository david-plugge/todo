import PocketBase from 'pocketbase';
import { writable, type Readable } from 'svelte/store';
import { isTauri } from './platform';

// Server URL is remembered separately from the auth token so the "Connect"
// form can prefill it even after logout. The auth token itself is persisted
// by PocketBase's default LocalAuthStore (localStorage), so login survives
// reloads and app restarts.
const URL_KEY = 'todo.serverUrl';

// When the production web build is served BY PocketBase (a browser, not the
// Tauri shell, not the vite dev server), the sync API is same-origin — so the
// server URL is simply the current origin and no URL entry is needed. The Tauri
// desktop app and vite dev keep the manual/remembered URL.
export function isSameOriginServer(): boolean {
	return (
		import.meta.env.PROD &&
		!isTauri &&
		typeof window !== 'undefined' &&
		/^https?:$/.test(window.location.protocol)
	);
}

export function getServerUrl(): string {
	// Same-origin is authoritative (and robust to the deploy domain changing),
	// so it wins over any remembered URL.
	if (isSameOriginServer()) return window.location.origin;
	return localStorage.getItem(URL_KEY) ?? '';
}

export function setServerUrl(url: string): void {
	const clean = url.trim().replace(/\/+$/, '');
	localStorage.setItem(URL_KEY, clean);
	pb.baseURL = clean;
}

export const pb = new PocketBase(getServerUrl() || 'http://127.0.0.1:8090');
pb.autoCancellation(false);

export interface AuthState {
	connected: boolean;
	email: string | null;
	userId: string | null;
}

function snapshot(): AuthState {
	const rec = pb.authStore.record;
	return {
		connected: pb.authStore.isValid,
		email: (rec?.email as string) ?? null,
		userId: rec?.id ?? null,
	};
}

const auth = writable<AuthState>(snapshot());
// Fires on login, logout, and token refresh — keeps the UI in sync.
pb.authStore.onChange(() => auth.set(snapshot()));

export const authState: Readable<AuthState> = { subscribe: auth.subscribe };

export async function login(email: string, password: string): Promise<void> {
	await pb.collection('users').authWithPassword(email, password);
}

export function logout(): void {
	pb.authStore.clear();
}
