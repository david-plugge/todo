export function canSubmitDraft(pending: boolean, title: string) {
  return !pending && title.trim().length > 0;
}

export function shouldResetDraft(submittedAt: number, currentEpoch: number) {
  return submittedAt === currentEpoch;
}

export interface DraftRecurrence {
  rule: string | null;
  date: string | null;
}

/**
 * A recurrence needs a calendar anchor: it follows the due date when there is one,
 * otherwise the planned date, and disappears once the draft has neither.
 */
export function anchorDraftRecurrence(
  recurrence: DraftRecurrence,
  plannedDate: string | null,
  dueDate: string | null,
): DraftRecurrence {
  if (!recurrence.rule) return { rule: null, date: null };
  const anchor = dueDate ?? plannedDate;
  return anchor ? { rule: recurrence.rule, date: anchor } : { rule: null, date: null };
}
