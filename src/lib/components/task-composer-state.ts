export function canSubmitDraft(pending: boolean, title: string) {
  return !pending && title.trim().length > 0;
}

export function shouldResetDraft(submittedAt: number, currentEpoch: number) {
  return submittedAt === currentEpoch;
}
