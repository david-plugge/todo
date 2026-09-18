import type { FieldVersions, Task, TaskList } from './models';

export const taskFields = [
  'title',
  'completed',
  'deletedAt',
  'rank',
  'dueDate',
  'plannedDate',
  'recurrenceRule',
  'recurrenceDate',
  'seriesId',
  'listId',
] as const;
export const listFields = ['name', 'deletedAt', 'rank'] as const;

/** Legacy records acquire deterministic baseline stamps without rewriting queued requests. */
export function versions(entity: Task | TaskList): FieldVersions {
  const fields = 'title' in entity ? taskFields : listFields;
  return Object.fromEntries(
    fields.map((field) => [
      field,
      entity.fieldVersions?.[field] ?? {
        counter: (entity as unknown as Record<string, unknown>)[field] == null ? 0 : entity.version,
        deviceId: '',
      },
    ]),
  );
}

/** One Lamport tick per local edit; only changed fields receive the new stamp. */
export function stampChanges(entity: Task | TaskList, fields: readonly string[], deviceId: string) {
  const stamps = versions(entity);
  const counter =
    Math.max(entity.version, ...Object.values(stamps).map((stamp) => stamp.counter)) + 1;
  if (!Number.isSafeInteger(counter)) throw new Error('Field counter exhausted');
  for (const field of fields) stamps[field] = { counter, deviceId };
  entity.fieldVersions = stamps;
  entity.version = counter;
}

export function initialVersions(fields: readonly string[], deviceId: string): FieldVersions {
  return Object.fromEntries(
    fields.map((field) => [
      field,
      {
        counter: ['title', 'completed', 'name'].includes(field) ? 1 : 0,
        deviceId: ['title', 'completed', 'name'].includes(field) ? deviceId : '',
      },
    ]),
  );
}
