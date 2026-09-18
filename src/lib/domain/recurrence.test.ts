import { describe, expect, it } from 'vitest';
import {
  canonicalRecurrenceRule,
  isRecurrenceRuleStructurallyEditable,
  nextOccurrenceDate,
  occurrenceId,
  shiftCalendarDate,
} from './recurrence';
import { validEntity } from './validation';

describe('calendar recurrence', () => {
  it('canonicalizes and advances an every-two-weeks rule', () => {
    expect(canonicalRecurrenceRule('freq=weekly;interval=2')).toBe('FREQ=WEEKLY;INTERVAL=2');
    expect(nextOccurrenceDate('FREQ=WEEKLY;INTERVAL=2', '2026-09-15')).toBe('2026-09-29');
  });

  it('finds the second Tuesday of the following month', () => {
    expect(nextOccurrenceDate('FREQ=MONTHLY;BYDAY=2TU', '2026-09-08')).toBe('2026-10-13');
  });

  it('keeps a fifth weekday editable and protects multiple month days from editor data loss', () => {
    expect(canonicalRecurrenceRule('FREQ=MONTHLY;BYDAY=5MO')).toBe('FREQ=MONTHLY;BYDAY=+5MO');
    expect(isRecurrenceRuleStructurallyEditable('FREQ=MONTHLY;BYDAY=5MO', '2026-09-15')).toBe(true);

    expect(canonicalRecurrenceRule('FREQ=MONTHLY;BYMONTHDAY=1,15')).toBe(
      'FREQ=MONTHLY;BYMONTHDAY=1,15',
    );
    expect(isRecurrenceRuleStructurallyEditable('FREQ=MONTHLY;BYMONTHDAY=1,15', '2026-09-15')).toBe(
      false,
    );
  });

  it('moves task dates by the occurrence calendar-day distance', () => {
    expect(shiftCalendarDate('2026-09-10', '2026-09-08', '2026-10-13')).toBe('2026-10-15');
    expect(shiftCalendarDate(null, '2026-09-08', '2026-10-13')).toBeNull();
  });

  it('builds an RFC 4122 UUIDv5 from the series namespace and date', async () => {
    await expect(occurrenceId('6ba7b810-9dad-11d1-80b4-00c04fd430c8', '2026-09-18')).resolves.toBe(
      'bd85101b-a814-5350-bde3-dbabfa2b915a',
    );
  });

  it('rejects sub-day and count-limited rules that cannot be advanced date-only', () => {
    expect(() => canonicalRecurrenceRule('FREQ=HOURLY')).toThrow('Ungültige Wiederholungsregel');
    expect(() => canonicalRecurrenceRule('FREQ=DAILY;COUNT=3')).toThrow(
      'Ungültige Wiederholungsregel',
    );
    expect(() => canonicalRecurrenceRule('FREQ=DAILY;UNTIL=20261001T000000Z')).toThrow(
      'Ungültige Wiederholungsregel',
    );
  });

  it('accepts only complete recurring series from remote JSON', () => {
    const task = {
      id: 'task',
      title: 'Remote',
      completed: false,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      recurrenceRule: 'FREQ=WEEKLY;INTERVAL=2',
      recurrenceDate: '2026-09-15',
      seriesId: '00000000-0000-4000-8000-000000000001',
    };
    expect(validEntity(task, 'task')).toBe(true);
    expect(validEntity({ ...task, seriesId: null }, 'task')).toBe(false);
    expect(validEntity({ ...task, recurrenceRule: 'FREQ=HOURLY' }, 'task')).toBe(false);
  });
});
