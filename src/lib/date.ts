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

/** Weekday (0=Sun…6=Sat) of an ISO date, in local time. */
function dow(iso: ISODate): number {
	const [y, m, d] = iso.split('-').map(Number);
	return new Date(y, m - 1, d).getDay();
}

/** The next date strictly after `from` that falls on weekday `target` (0=Sun…6=Sat). */
export function nextDow(target: number, from: ISODate = todayISO()): ISODate {
	let add = (target - dow(from) + 7) % 7;
	if (add === 0) add = 7;
	return addDaysISO(from, add);
}

function fmt(iso: ISODate, opts: Intl.DateTimeFormatOptions): string {
	const [y, m, d] = iso.split('-').map(Number);
	return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
}

export interface DatePreset {
	label: string;
	icon: string;
	color: string;
	date: ISODate;
	hint: string; // short weekday/date preview
}

/** Quick-date presets offered by the date picker: Today / Tomorrow / Next week / Next weekend. */
export function datePresets(today: ISODate = todayISO()): DatePreset[] {
	const tomorrow = addDaysISO(today, 1);
	const nextWeek = nextDow(1, today); // Monday
	const nextWeekend = nextDow(6, today); // Saturday
	return [
		{ label: 'Today', icon: 'today', color: '#22c55e', date: today, hint: fmt(today, { weekday: 'short' }) },
		{ label: 'Tomorrow', icon: 'sun', color: '#f59e0b', date: tomorrow, hint: fmt(tomorrow, { weekday: 'short' }) },
		{
			label: 'Next week',
			icon: 'next',
			color: '#8b5cf6',
			date: nextWeek,
			hint: fmt(nextWeek, { weekday: 'short', day: 'numeric', month: 'short' }),
		},
		{
			label: 'Next weekend',
			icon: 'weekend',
			color: '#06b6d4',
			date: nextWeekend,
			hint: fmt(nextWeekend, { weekday: 'short', day: 'numeric', month: 'short' }),
		},
	];
}
