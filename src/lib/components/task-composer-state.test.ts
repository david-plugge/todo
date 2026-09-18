import { describe, expect, it } from 'vitest';
import { canSubmitDraft, shouldResetDraft } from './task-composer-state';

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
