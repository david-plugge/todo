import type { Table } from 'dexie';
import { db } from './db';
import type { Change, Project, Task } from './types';

// Materialize the change-log into the tasks/projects render cache via
// per-field last-write-wins. An entity exists once any change for it arrives;
// unseen fields fall back to these defaults.

function taskSkeleton(id: string): Task {
	return {
		id,
		title: '',
		notes: '',
		projectId: null,
		dueDate: null,
		plannedDate: null,
		completed: 0,
		completedAt: null,
		rank: '',
		todayRank: '',
		createdAt: 0,
		deletedAt: null,
		clocks: {},
	};
}

function projectSkeleton(id: string): Project {
	return { id, name: '', color: '#6366f1', rank: '', createdAt: 0, deletedAt: null, clocks: {} };
}

/**
 * Apply one change to the materialized state. Idempotent and commutative:
 * a change wins a field only if its HLC exceeds the field's current clock, so
 * replaying in any order (or twice) converges to the same result.
 *
 * Must run inside a Dexie rw transaction covering the target table.
 */
export async function applyChange(ch: Change): Promise<void> {
	const table = (ch.entity === 'task' ? db.tasks : db.projects) as Table<Task | Project, string>;
	const rec =
		(await table.get(ch.entityId)) ??
		(ch.entity === 'task' ? taskSkeleton(ch.entityId) : projectSkeleton(ch.entityId));

	if (ch.hlc > (rec.clocks[ch.field] ?? '')) {
		(rec as unknown as Record<string, unknown>)[ch.field] = ch.value;
		rec.clocks[ch.field] = ch.hlc;
		await table.put(rec);
	}
}
