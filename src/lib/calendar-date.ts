import { CalendarDate, parseDate, type DateValue } from '@internationalized/date';
import type { ISODate } from './types';

/**
 * Adapter between the app's `ISODate` strings ("YYYY-MM-DD") and the
 * `@internationalized/date` `DateValue` used by shadcn's Calendar component.
 * Convert only at the component boundary — everything else stays `ISODate`.
 */

export function toDateValue(iso: ISODate | null): DateValue | undefined {
	return iso ? parseDate(iso) : undefined;
}

export function fromDateValue(v: DateValue | undefined): ISODate | null {
	if (!v) return null;
	// Normalise to a plain calendar date, dropping any time/zone component.
	return new CalendarDate(v.year, v.month, v.day).toString() as ISODate;
}
