import { writable, type Readable } from 'svelte/store';
import { db } from './db';
import { pb } from './pb';
import { applyChange } from './reducer';
import * as hlc from './hlc';

// -----------------------------------------------------------------------------
// Sync the append-only change-log against PocketBase.
//
//  - Push: create locally-recorded changes the server hasn't seen (idempotent
//    via a unique client-change-id `cid`).
//  - Pull: fetch changes appended since our cursor (server `created`), advance
//    our HLC past each, and replay them into the materialized state.
//  - Realtime: an SSE subscription applies new changes the instant they land.
//
// Because every change is immutable and merges by per-field HLC, replay is
// order-independent and idempotent — devices always converge. No re-push hacks.
// -----------------------------------------------------------------------------

export type SyncPhase = 'disabled' | 'idle' | 'syncing' | 'error';
export interface SyncStatus {
	phase: SyncPhase;
	lastSyncedAt: number | null;
	error: string | null;
}

const status = writable<SyncStatus>({ phase: 'disabled', lastSyncedAt: null, error: null });
export const syncStatus: Readable<SyncStatus> = { subscribe: status.subscribe };

const CURSOR_KEY = 'todo.sync.cursor';
const ACCOUNT_KEY = 'todo.sync.account';
const getCursor = () => localStorage.getItem(CURSOR_KEY) ?? '';
const setCursor = (v: string) => localStorage.setItem(CURSOR_KEY, v);

// A different account must not reuse the previous account's pull cursor.
function resetForAccount(userId: string): void {
	if (localStorage.getItem(ACCOUNT_KEY) === userId) return;
	localStorage.removeItem(CURSOR_KEY);
	localStorage.setItem(ACCOUNT_KEY, userId);
}

// --- ingest remote changes ---------------------------------------------------
async function ingest(records: any[]): Promise<void> {
	await db.transaction('rw', db.changes, db.tasks, db.projects, async () => {
		for (const r of records) {
			hlc.recv(r.hlc);
			const ch = {
				id: r.cid,
				entity: r.entity,
				entityId: r.entityId,
				field: r.field,
				value: r.value,
				hlc: r.hlc,
				synced: 1 as const,
			};
			if (!(await db.changes.get(r.cid))) await db.changes.add(ch);
			await applyChange(ch);
		}
	});
}

// --- pull / push -------------------------------------------------------------
async function pullChanges(): Promise<void> {
	const cursor = getCursor();
	const filter = cursor ? `created > "${cursor}"` : '';
	const records = await pb.collection('changes').getFullList({ filter, sort: 'created' });
	if (!records.length) return;
	await ingest(records);
	setCursor((records[records.length - 1] as any).created);
}

async function pushChanges(owner: string): Promise<void> {
	const unsynced = await db.changes.where('synced').equals(0).toArray();
	unsynced.sort((a, b) => (a.hlc < b.hlc ? -1 : 1));
	let lastErr: unknown = null;
	for (const ch of unsynced) {
		try {
			await pb.collection('changes').create({
				cid: ch.id,
				entity: ch.entity,
				entityId: ch.entityId,
				field: ch.field,
				value: ch.value,
				hlc: ch.hlc,
				nodeId: hlc.unpack(ch.hlc).node,
				owner,
			});
			await db.changes.update(ch.id, { synced: 1 });
		} catch (e: any) {
			// Unique `cid` violation → a prior push already landed it; treat as done.
			const dup = e?.status === 400 && (e?.response?.data?.cid || e?.data?.cid);
			if (dup) {
				await db.changes.update(ch.id, { synced: 1 });
			} else {
				// Leave this one unsynced and keep going, so one bad change can't wedge
				// the rest of the backlog. It retries on the next sync.
				lastErr = e;
			}
		}
	}
	if (lastErr) throw lastErr; // surface an error status so a retry is scheduled
}

let running = false;
export async function syncNow(): Promise<void> {
	if (!pb.authStore.isValid) return;
	const owner = pb.authStore.record?.id;
	if (!owner || running) return;
	running = true;
	status.update((s) => ({ ...s, phase: 'syncing', error: null }));
	resetForAccount(owner);
	// Pull and push are independent: a pull failure must never block pushing the
	// local backlog (e.g. tasks created before connecting), and vice versa.
	let err: any = null;
	try {
		await pullChanges();
	} catch (e) {
		err = e;
	}
	try {
		await pushChanges(owner);
	} catch (e) {
		err = e;
	}
	if (err) {
		status.update((s) => ({
			...s,
			phase: 'error',
			error: err?.response?.message || err?.message || 'Sync failed',
		}));
	} else {
		status.set({ phase: 'idle', lastSyncedAt: Date.now(), error: null });
	}
	running = false;
}

// --- realtime + triggers -----------------------------------------------------
let interval: ReturnType<typeof setInterval> | undefined;
let unsubscribe: (() => void) | null = null;
const onWake = () => {
	if (navigator.onLine) syncNow();
};

async function subscribeRealtime(): Promise<void> {
	try {
		unsubscribe = await pb.collection('changes').subscribe('*', (e) => {
			if (e.action !== 'create') return;
			ingest([e.record])
				.then(() => {
					const created = (e.record as any).created;
					if (created > getCursor()) setCursor(created);
					status.update((s) => ({ ...s, lastSyncedAt: Date.now() }));
				})
				.catch((err) => console.error('realtime ingest failed', err));
		});
	} catch (err) {
		console.error('realtime subscribe failed', err);
	}
}

/** Begin realtime + safety-net polling. Safe to call repeatedly. */
export function startSync(): void {
	stopSync();
	if (!pb.authStore.isValid) {
		status.set({ phase: 'disabled', lastSyncedAt: null, error: null });
		return;
	}
	syncNow();
	subscribeRealtime();
	// Realtime carries live updates; the poll is a safety net for missed SSE
	// events (dropped connections) and offline catch-up.
	interval = setInterval(onWake, 60_000);
	window.addEventListener('focus', onWake);
	window.addEventListener('online', onWake);
}

export function stopSync(): void {
	clearInterval(interval);
	window.removeEventListener('focus', onWake);
	window.removeEventListener('online', onWake);
	if (unsubscribe) {
		unsubscribe();
		unsubscribe = null;
	}
	status.set({ phase: 'disabled', lastSyncedAt: null, error: null });
}

/** Called after local edits — coalesces a sync shortly after they settle. */
let debounce: ReturnType<typeof setTimeout> | undefined;
export function scheduleSync(): void {
	if (!pb.authStore.isValid) return;
	clearTimeout(debounce);
	debounce = setTimeout(onWake, 1500);
}
