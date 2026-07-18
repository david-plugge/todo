import { generateKeyBetween } from 'fractional-indexing';
import { db, newId } from './db';
import { live } from './live';
import { todayISO } from './date';
import { applyChange } from './reducer';
import { scheduleSync } from './sync';
import * as hlc from './hlc';
import type { EntityType, ID, ISODate, Project, Task, Selection } from './types';

// ---------------------------------------------------------------------------
// Ordering + query helpers
// ---------------------------------------------------------------------------

const byRank = <T extends { rank: string }>(a: T, b: T) =>
	a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0;

const live_ = <T extends { deletedAt: number | null }>(rows: T[]) =>
	rows.filter((r) => !r.deletedAt);

// ---------------------------------------------------------------------------
// Queries (reactive stores)
// ---------------------------------------------------------------------------

export const projects = live<Project[]>(
	async () => live_(await db.projects.toArray()).sort(byRank),
	[],
);

async function activeTasks(): Promise<Task[]> {
	return live_(await db.tasks.toArray());
}

/**
 * Today = planned for today-or-earlier OR due today-or-earlier (and still open),
 * plus anything completed today so you can see what you got done. Completed
 * tasks sink to the bottom; the rest keep their manual `todayRank` order.
 */
export function todayTasks() {
	return live<Task[]>(async () => {
		const today = todayISO();
		return (await activeTasks())
			.filter((t) => {
				if (t.completed)
					return t.completedAt != null && todayISO(new Date(t.completedAt)) === today;
				return (
					(t.plannedDate != null && t.plannedDate <= today) ||
					(t.dueDate != null && t.dueDate <= today)
				);
			})
			.sort((a, b) => {
				if (a.completed !== b.completed) return a.completed - b.completed;
				return a.todayRank < b.todayRank ? -1 : a.todayRank > b.todayRank ? 1 : 0;
			});
	}, []);
}

export function inboxTasks() {
	return live<Task[]>(async () => {
		return (await activeTasks()).filter((t) => t.projectId == null && !t.completed).sort(byRank);
	}, []);
}

export function projectTasks(projectId: ID) {
	return live<Task[]>(async () => {
		return (await activeTasks())
			.filter((t) => t.projectId === projectId && !t.completed)
			.sort(byRank);
	}, []);
}

export function upcomingTasks() {
	return live<Task[]>(async () => {
		const today = todayISO();
		return (await activeTasks())
			.filter((t) => !t.completed && t.plannedDate != null && t.plannedDate > today)
			.sort((a, b) => (a.plannedDate! < b.plannedDate! ? -1 : 1));
	}, []);
}

export function allTasks() {
	return live<Task[]>(async () => {
		return (await activeTasks()).filter((t) => !t.completed).sort(byRank);
	}, []);
}

export function tasksForSelection(sel: Selection) {
	if (sel.kind === 'project') return projectTasks(sel.id);
	switch (sel.view) {
		case 'today':
			return todayTasks();
		case 'inbox':
			return inboxTasks();
		case 'upcoming':
			return upcomingTasks();
		case 'all':
			return allTasks();
	}
}

// ---------------------------------------------------------------------------
// Mutations — every field edit becomes an HLC-stamped change, appended to the
// log and replayed into the materialized record. Then a sync is scheduled.
// ---------------------------------------------------------------------------

const now = () => Date.now();

/** Append one change per field, apply locally, and queue a push. */
async function record(
	entity: EntityType,
	entityId: ID,
	fields: Record<string, unknown>,
): Promise<void> {
	const table = entity === 'task' ? db.tasks : db.projects;
	await db.transaction('rw', db.changes, table, async () => {
		for (const [field, value] of Object.entries(fields)) {
			const h = hlc.send();
			const change = { id: newId(), entity, entityId, field, value, hlc: h, synced: 0 as const };
			await db.changes.add(change);
			await applyChange(change);
		}
	});
	scheduleSync();
}

/** A fractional key that sorts a new task to the TOP of `field`'s ordering. */
async function topRank(field: 'rank' | 'todayRank'): Promise<string> {
	const keys = live_(await db.tasks.toArray())
		.map((t) => t[field])
		.filter(Boolean)
		.sort();
	return generateKeyBetween(null, keys[0] ?? null);
}

export async function addTask(input: {
	title: string;
	projectId?: ID | null;
	plannedDate?: ISODate | null;
	dueDate?: ISODate | null;
	notes?: string;
}): Promise<ID> {
	const id = newId();
	const [rank, todayRank] = await Promise.all([topRank('rank'), topRank('todayRank')]);
	await record('task', id, {
		title: input.title.trim(),
		notes: input.notes ?? '',
		projectId: input.projectId ?? null,
		dueDate: input.dueDate ?? null,
		plannedDate: input.plannedDate ?? null,
		completed: 0,
		completedAt: null,
		rank,
		todayRank,
		createdAt: now(),
		deletedAt: null,
	});
	return id;
}

export async function updateTask(id: ID, patch: Partial<Task>): Promise<void> {
	await record('task', id, patch as Record<string, unknown>);
}

export async function toggleComplete(task: Task): Promise<void> {
	const done = task.completed ? 0 : 1;
	await record('task', task.id, { completed: done, completedAt: done ? now() : null });
}

export async function deleteTask(id: ID): Promise<void> {
	await record('task', id, { deletedAt: now() });
}

/** Persist a drag-reorder by giving the moved task a rank between its neighbors. */
export async function moveInList(
	items: Task[],
	movedId: ID,
	field: 'rank' | 'todayRank',
): Promise<void> {
	const idx = items.findIndex((t) => t.id === movedId);
	if (idx < 0) return;
	const left = idx > 0 ? items[idx - 1][field] : null;
	const right = idx < items.length - 1 ? items[idx + 1][field] : null;
	await record('task', movedId, { [field]: generateKeyBetween(left, right) });
}

// ---- Projects ----

async function bottomProjectRank(): Promise<string> {
	const keys = live_(await db.projects.toArray())
		.map((p) => p.rank)
		.filter(Boolean)
		.sort();
	return generateKeyBetween(keys[keys.length - 1] ?? null, null);
}

export async function addProject(name: string, color: string): Promise<ID> {
	const id = newId();
	await record('project', id, {
		name: name.trim(),
		color,
		rank: await bottomProjectRank(),
		createdAt: now(),
		deletedAt: null,
	});
	return id;
}

export async function updateProject(id: ID, patch: Partial<Project>): Promise<void> {
	await record('project', id, patch as Record<string, unknown>);
}

export async function deleteProject(id: ID): Promise<void> {
	// Soft-delete the project; orphan its tasks back to the Inbox.
	await record('project', id, { deletedAt: now() });
	const orphans = (await db.tasks.toArray()).filter((t) => t.projectId === id && !t.deletedAt);
	for (const t of orphans) await record('task', t.id, { projectId: null });
}
