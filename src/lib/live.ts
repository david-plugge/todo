import { liveQuery } from 'dexie';
import { readable, type Readable } from 'svelte/store';

/**
 * Adapt a Dexie liveQuery into a Svelte store so results stay reactive as the
 * IndexedDB data changes (including writes from other tabs / the sync engine).
 */
export function live<T>(querier: () => T | Promise<T>, initial: T): Readable<T> {
	const observable = liveQuery(querier);
	return readable<T>(initial, (set) => {
		const sub = observable.subscribe({
			next: (v) => set(v),
			error: (e) => console.error('liveQuery error', e),
		});
		return () => sub.unsubscribe();
	});
}
