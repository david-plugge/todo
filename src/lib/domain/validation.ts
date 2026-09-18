import { validDate } from './dates';
import { validRank } from '../ranking/rank';
import { listFields, taskFields } from './versions';
import { validRecurrenceRule, validUuid } from './recurrence';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 2000;

/** Remote JSON is untrusted even when the transport advertises TypeScript types. */
export function validEntity(value: unknown, kind: 'task' | 'list'): boolean {
  if (!record(value) || !text(value.id) || !positiveInteger(value.version)) return false;
  if (value.deletedAt !== undefined && !positiveInteger(value.deletedAt)) return false;
  if (value.rank !== undefined && !validRank(value.rank)) return false;
  if (value.fieldVersions !== undefined) {
    if (!record(value.fieldVersions)) return false;
    const fields: readonly string[] = kind === 'task' ? taskFields : listFields;
    for (const [field, stamp] of Object.entries(value.fieldVersions)) {
      if (
        !fields.includes(field) ||
        !record(stamp) ||
        typeof stamp.counter !== 'number' ||
        !Number.isSafeInteger(stamp.counter) ||
        stamp.counter < 0 ||
        // Legacy baseline stamps intentionally have an empty device ID, even at positive counters.
        typeof stamp.deviceId !== 'string'
      )
        return false;
    }
  }
  if (kind === 'list') return text(value.name);
  return (
    text(value.title) &&
    typeof value.completed === 'boolean' &&
    positiveInteger(value.createdAt) &&
    positiveInteger(value.updatedAt) &&
    (value.dueDate === undefined || validDate(value.dueDate)) &&
    (value.plannedDate === undefined || validDate(value.plannedDate)) &&
    (value.recurrenceRule === undefined ||
      value.recurrenceRule === null ||
      validRecurrenceRule(value.recurrenceRule)) &&
    (value.recurrenceDate === undefined || validDate(value.recurrenceDate)) &&
    (value.seriesId === undefined || value.seriesId === null || validUuid(value.seriesId)) &&
    ((value.recurrenceRule == null && value.recurrenceDate == null && value.seriesId == null) ||
      (typeof value.recurrenceRule === 'string' &&
        typeof value.recurrenceDate === 'string' &&
        typeof value.seriesId === 'string')) &&
    (value.listId === undefined || value.listId === null || text(value.listId))
  );
}
