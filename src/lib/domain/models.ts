export interface FieldVersion {
  counter: number;
  deviceId: string;
}
export type FieldVersions = Record<string, FieldVersion>;
export interface Task {
  id: string;
  ownerId?: string;
  remoteRevision?: number;
  fieldVersions?: FieldVersions;
  title: string;
  description?: string | null;
  completed: boolean;
  rank?: string;
  dueDate?: string | null;
  plannedDate?: string | null;
  recurrenceRule?: string | null;
  recurrenceDate?: string | null;
  seriesId?: string | null;
  listId?: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}
export interface TaskList {
  rank?: string;
  fieldVersions?: FieldVersions;
  id: string;
  name: string;
  version: number;
  ownerId?: string;
  remoteRevision?: number;
  deletedAt?: number;
}
export interface OutboxEntry {
  id: string;
  entityType: 'task' | 'list';
  entityId: string;
  operation: 'create' | 'update' | 'delete';
  entityVersion: number;
  createdAt: number;
  retryCount: number;
  nextAttemptAt?: number;
  lastError?: string;
  payload: Task | TaskList;
  deviceId?: string;
  baseRevision?: number;
}
export interface SyncMetadata {
  id: string;
  revision: number;
  createdAt?: number;
  leaseUntil?: number;
  cursor?: number;
  generation?: string;
  sourceCursor?: number;
  sourceGeneration?: string;
  until?: number;
  kind?: 'task' | 'list';
  snapshotCursor?: string;
  entityType?: 'task' | 'list';
  entityId?: string;
  payload?: Task | TaskList;
}

/** Strip TanStack virtual properties before placing an immutable snapshot in the outbox. */
export function taskSnapshot(task: Task): Task {
  return {
    id: task.id,
    title: task.title,
    completed: task.completed,
    version: task.version,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.description === undefined ? {} : { description: task.description }),
    ...(task.rank === undefined ? {} : { rank: task.rank }),
    ...(task.dueDate === undefined ? {} : { dueDate: task.dueDate }),
    ...(task.plannedDate === undefined ? {} : { plannedDate: task.plannedDate }),
    ...(task.recurrenceRule === undefined ? {} : { recurrenceRule: task.recurrenceRule }),
    ...(task.recurrenceDate === undefined ? {} : { recurrenceDate: task.recurrenceDate }),
    ...(task.seriesId === undefined ? {} : { seriesId: task.seriesId }),
    ...(task.listId === undefined ? {} : { listId: task.listId }),
    ...(task.ownerId === undefined
      ? {}
      : { ownerId: task.ownerId, remoteRevision: task.remoteRevision ?? 0 }),
    ...(task.fieldVersions
      ? {
          fieldVersions: Object.fromEntries(
            Object.entries(task.fieldVersions).map(([field, stamp]) => [
              field,
              { counter: stamp.counter, deviceId: stamp.deviceId },
            ]),
          ),
        }
      : {}),
    ...(task.deletedAt === undefined ? {} : { deletedAt: task.deletedAt }),
  };
}
