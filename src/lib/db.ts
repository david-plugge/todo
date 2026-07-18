import Dexie, { type Table, type Transaction } from 'dexie';
import { generateNKeysBetween } from 'fractional-indexing';
import type { Change, Project, Task } from './types';
import * as hlc from './hlc';

export class TodoDB extends Dexie {
	tasks!: Table<Task, string>;
	projects!: Table<Project, string>;
	changes!: Table<Change, string>;

	constructor() {
		super('todo');

		// v1 — legacy record-level-LWW schema. Kept so existing installs upgrade.
		this.version(1).stores({
			tasks:
				'id, projectId, plannedDate, dueDate, completed, deleted, sortOrder, todayOrder, updatedAt',
			projects: 'id, sortOrder, deleted, updatedAt',
		});

		// v2 — change-log model: materialized tasks/projects + an append-only
		// `changes` log. Only indexed fields are listed.
		this.version(2)
			.stores({
				tasks: 'id, rank',
				projects: 'id, rank',
				changes: 'id, synced, hlc',
			})
			.upgrade((tx) => migrateV1toV2(tx));
	}
}

export const db = new TodoDB();

/** Crypto-random id — stable across devices, safe as a sync primary key. */
export function newId(): string {
	return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// v1 -> v2: convert each legacy record into the new shape AND emit unsynced
// field-changes for it, so existing data both keeps working locally and
// propagates to the server on first sync. No-op on a fresh install.
// ---------------------------------------------------------------------------
async function migrateV1toV2(tx: Transaction): Promise<void> {
	const fallback = Date.now();

	async function emit(entity: 'task' | 'project', rec: any, fields: string[]): Promise<void> {
		for (const f of fields) {
			const h = hlc.send();
			rec.clocks[f] = h;
			await tx.table('changes').add({
				id: crypto.randomUUID(),
				entity,
				entityId: rec.id,
				field: f,
				value: rec[f],
				hlc: h,
				synced: 0,
			});
		}
		await tx.table(entity === 'task' ? 'tasks' : 'projects').put(rec);
	}

	const oldProjects = (await tx.table('projects').toArray()) as any[];
	oldProjects.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
	const pRanks = oldProjects.length ? generateNKeysBetween(null, null, oldProjects.length) : [];
	for (let i = 0; i < oldProjects.length; i++) {
		const o = oldProjects[i];
		const rec: Project = {
			id: o.id,
			name: o.name ?? '',
			color: o.color ?? '#6366f1',
			rank: pRanks[i],
			createdAt: o.createdAt ?? fallback,
			deletedAt: o.deleted ? (o.updatedAt ?? fallback) : null,
			clocks: {},
		};
		await emit('project', rec, ['name', 'color', 'rank', 'createdAt', 'deletedAt']);
	}

	const oldTasks = (await tx.table('tasks').toArray()) as any[];
	const bySort = [...oldTasks].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
	const byToday = [...oldTasks].sort((a, b) => (a.todayOrder ?? 0) - (b.todayOrder ?? 0));
	const rankKeys = bySort.length ? generateNKeysBetween(null, null, bySort.length) : [];
	const todayKeys = byToday.length ? generateNKeysBetween(null, null, byToday.length) : [];
	const rankOf = new Map(bySort.map((t, i) => [t.id, rankKeys[i]]));
	const todayOf = new Map(byToday.map((t, i) => [t.id, todayKeys[i]]));
	for (const o of oldTasks) {
		const rec: Task = {
			id: o.id,
			title: o.title ?? '',
			notes: o.notes ?? '',
			projectId: o.projectId ?? null,
			dueDate: o.dueDate ?? null,
			plannedDate: o.plannedDate ?? null,
			completed: o.completed ? 1 : 0,
			completedAt: o.completedAt ?? null,
			rank: rankOf.get(o.id)!,
			todayRank: todayOf.get(o.id)!,
			createdAt: o.createdAt ?? fallback,
			deletedAt: o.deleted ? (o.updatedAt ?? fallback) : null,
			clocks: {},
		};
		await emit('task', rec, [
			'title',
			'notes',
			'projectId',
			'dueDate',
			'plannedDate',
			'completed',
			'completedAt',
			'rank',
			'todayRank',
			'createdAt',
			'deletedAt',
		]);
	}
}
