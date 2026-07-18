export type ID = string;

/** ISO calendar date, e.g. "2026-07-18". No time component. */
export type ISODate = string;

/**
 * Per-field Hybrid Logical Clocks. `clocks[field]` is the HLC of the change
 * that last set that field; the reducer applies an incoming change only when
 * its HLC is greater. Internal sync metadata — the UI ignores it.
 */
export type FieldClocks = Record<string, string>;

export interface Project {
	id: ID;
	name: string;
	color: string; // hex accent, e.g. "#6366f1"
	rank: string; // fractional-index order key
	createdAt: number;
	deletedAt: number | null; // tombstone timestamp; null = live
	clocks: FieldClocks;
}

export interface Task {
	id: ID;
	title: string;
	notes: string;
	projectId: ID | null; // null = Inbox
	dueDate: ISODate | null; // hard deadline
	plannedDate: ISODate | null; // when you intend to work on it
	completed: 0 | 1;
	completedAt: number | null;
	rank: string; // fractional-index order within project / inbox
	todayRank: string; // fractional-index order within the Today view
	createdAt: number;
	deletedAt: number | null; // tombstone timestamp; null = live
	clocks: FieldClocks;
}

export type EntityType = 'task' | 'project';

/**
 * One immutable field edit — the unit of sync. The append-only stream of these
 * is the source of truth; `tasks`/`projects` are a materialized replay of it.
 */
export interface Change {
	id: ID; // client change id (cid) — globally unique, dedupes across devices
	entity: EntityType;
	entityId: ID;
	field: string;
	value: unknown;
	hlc: string;
	synced: 0 | 1; // pushed to the server yet?
}

/** Special views that aren't real projects. */
export type SpecialView = 'today' | 'inbox' | 'upcoming' | 'all';
export type Selection = { kind: 'view'; view: SpecialView } | { kind: 'project'; id: ID };
