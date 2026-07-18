import type { ISODate } from './types';

/** Local calendar date as "YYYY-MM-DD" (not UTC — respects the user's timezone). */
export function todayISO(d = new Date()): ISODate {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

export function addDaysISO(iso: ISODate, days: number): ISODate {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(y, m - 1, d);
	dt.setDate(dt.getDate() + days);
	return todayISO(dt);
}

/** Human label for a date relative to today: Today / Tomorrow / Yesterday / weekday / date. */
export function relativeLabel(iso: ISODate | null, today: ISODate = todayISO()): string {
	if (!iso) return '';
	if (iso === today) return 'Today';
	if (iso === addDaysISO(today, 1)) return 'Tomorrow';
	if (iso === addDaysISO(today, -1)) return 'Yesterday';
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(y, m - 1, d);
	const sameYear = y === new Date().getFullYear();
	return dt.toLocaleDateString(undefined, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		year: sameYear ? undefined : 'numeric',
	});
}

export function isOverdue(iso: ISODate | null, today: ISODate = todayISO()): boolean {
	return iso != null && iso < today;
}
