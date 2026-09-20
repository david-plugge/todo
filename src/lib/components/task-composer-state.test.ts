import { describe, expect, it } from 'vitest';
import { anchorDraftRecurrence, canSubmitDraft, shouldResetDraft } from './task-composer-state';

describe('task composer submission state', () => {
  it('blocks empty and duplicate submissions', () => {
    expect(canSubmitDraft(false, '  ')).toBe(false);
    expect(canSubmitDraft(true, 'Neue Aufgabe')).toBe(false);
    expect(canSubmitDraft(false, 'Neue Aufgabe')).toBe(true);
  });

  it('only clears the draft that was actually submitted', () => {
    expect(shouldResetDraft(4, 4)).toBe(true);
    expect(shouldResetDraft(4, 5)).toBe(false);
  });
});

describe('task composer recurrence anchor', () => {
  const weekly = { rule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO', date: '2026-09-21' };

  it('prefers the due date over the planned date', () => {
    expect(anchorDraftRecurrence(weekly, '2026-09-21', '2026-09-28')).toEqual({
      rule: weekly.rule,
      date: '2026-09-28',
    });
  });

  it('falls back to the planned date', () => {
    expect(anchorDraftRecurrence(weekly, '2026-09-21', null)).toEqual(weekly);
  });

  it('drops the rule when the draft has no date left', () => {
    expect(anchorDraftRecurrence(weekly, null, null)).toEqual({ rule: null, date: null });
  });
});
