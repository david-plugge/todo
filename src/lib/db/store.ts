import { createTransaction } from '@tanstack/db';
import { TodoDatabase } from './database';
import { DexieAdapter } from './adapter';
import { taskSnapshot, type OutboxEntry, type Task, type TaskList } from '../domain/models';
import { initialVersions, taskFields, listFields, stampChanges } from '../domain/versions';
import { validDate } from '../domain/dates';
import {
  canonicalRecurrenceRule,
  nextOccurrenceDate,
  occurrenceId,
  shiftCalendarDate,
  validUuid,
} from '../domain/recurrence';
import { balanced, compareRank, planPlacement, validRank } from '../ranking/rank';

import type {
  TaskChanges,
  ListChanges,
  CreateTaskOptions,
  DeleteListOptions,
  TodoCommands,
} from '../domain/commands';

export type TodoStore = ReturnType<typeof createStore>;
export type WorkspaceStore = TodoCommands & Pick<TodoStore, 'tasks' | 'lists' | 'outbox' | 'ready'>;
type InternalTaskChanges = TaskChanges & Partial<Pick<Task, 'seriesId'>>;
export function createStore(
  name?: string,
  account?: { ownerId: string; deviceId: string; onLocalWrite?: () => void },
) {
  const db = new TodoDatabase(name);
  const adapter = new DexieAdapter(db);
  const tasks = adapter.collection(db.tasks);
  const lists = adapter.collection(db.lists);
  const outbox = adapter.collection(db.outbox);
  const ready = Promise.all([tasks.preload(), lists.preload(), outbox.preload()]);
  const transact = (mutate: () => void) => {
    const tx = createTransaction({ mutationFn: adapter.persist });
    tx.mutate(mutate);
    return tx.isPersisted.promise;
  };
  const enqueue = (
    entity: Task | TaskList,
    kind: 'task' | 'list',
    operation: OutboxEntry['operation'],
  ) => {
    const payload =
      kind === 'task' ? taskSnapshot(entity as Task) : listSnapshot(entity as TaskList);
    outbox.insert({
      id: crypto.randomUUID(),
      entityType: kind,
      entityId: entity.id,
      operation,
      entityVersion: entity.version,
      createdAt: Date.now(),
      retryCount: 0,
      payload,
      ...(account ? { deviceId: account.deviceId, baseRevision: entity.remoteRevision ?? 0 } : {}),
    });
  };
  function listSnapshot(list: TaskList): TaskList {
    return {
      id: list.id,
      name: list.name,
      version: list.version,
      ...(list.rank === undefined ? {} : { rank: list.rank }),
      ...(list.ownerId ? { ownerId: list.ownerId, remoteRevision: list.remoteRevision ?? 0 } : {}),
      ...(list.fieldVersions ? { fieldVersions: structuredClone(list.fieldVersions) } : {}),
      ...(list.deletedAt === undefined ? {} : { deletedAt: list.deletedAt }),
    };
  }
  function validateChanges(changes: InternalTaskChanges | ListChanges, fields: readonly string[]) {
    if (
      Object.keys(changes).some((field) => !fields.includes(field)) ||
      Object.values(changes).some((value) => value === undefined)
    )
      throw new Error('Invalid change');
    for (const field of ['dueDate', 'plannedDate'] as const)
      if (field in changes && !validDate((changes as InternalTaskChanges)[field]))
        throw new Error('Ungültiges Kalenderdatum');
    if ('recurrenceDate' in changes && !validDate((changes as InternalTaskChanges).recurrenceDate))
      throw new Error('Ungültiges Wiederholungsdatum');
    if ('recurrenceRule' in changes && changes.recurrenceRule !== null)
      canonicalRecurrenceRule(changes.recurrenceRule);
    if ('seriesId' in changes && changes.seriesId !== null && !validUuid(changes.seriesId))
      throw new Error('Ungültige Serien-ID');
    if ('completed' in changes && typeof changes.completed !== 'boolean')
      throw new Error('Invalid completion status');
    if (
      'deletedAt' in changes &&
      (!Number.isSafeInteger(changes.deletedAt) || changes.deletedAt! <= 0)
    )
      throw new Error('Invalid deletion timestamp');
    if ('rank' in changes && !validRank(changes.rank)) throw new Error('Invalid rank');
    if (
      'title' in changes &&
      (typeof changes.title !== 'string' || !changes.title.trim() || changes.title.length > 2000)
    )
      throw new Error('Titel fehlt oder ist zu lang');
    if (
      'name' in changes &&
      (typeof changes.name !== 'string' || !changes.name.trim() || changes.name.length > 2000)
    )
      throw new Error('Listenname fehlt oder ist zu lang');
    if (
      'listId' in changes &&
      changes.listId !== null &&
      (!changes.listId ||
        !lists.get(changes.listId) ||
        lists.get(changes.listId)?.deletedAt !== undefined)
    )
      throw new Error('Liste nicht verfügbar');
  }
  function normalizeRecurrence(task: Task | undefined, changes: TaskChanges): InternalTaskChanges {
    const normalized: InternalTaskChanges = { ...changes };
    if ('recurrenceRule' in changes) {
      if (changes.recurrenceRule === null) {
        normalized.recurrenceRule = null;
        normalized.recurrenceDate = null;
        normalized.seriesId = null;
      } else {
        normalized.recurrenceRule = canonicalRecurrenceRule(changes.recurrenceRule);
        normalized.recurrenceDate =
          changes.recurrenceDate ??
          task?.recurrenceDate ??
          changes.plannedDate ??
          task?.plannedDate ??
          changes.dueDate ??
          task?.dueDate ??
          null;
        if (normalized.recurrenceDate === null)
          throw new Error('Für eine Wiederholung ist ein Kalenderdatum erforderlich');
        normalized.seriesId = task?.seriesId ?? crypto.randomUUID();
      }
    } else if ('recurrenceDate' in changes) {
      if (!task?.recurrenceRule || changes.recurrenceDate === null)
        throw new Error('Wiederholungsdatum ohne aktive Regel');
    }
    const future = { ...task, ...normalized };
    const recurrenceParts = [future.recurrenceRule, future.recurrenceDate, future.seriesId];
    if (
      recurrenceParts.some((value) => value != null) &&
      !recurrenceParts.every((value) => value != null)
    )
      throw new Error('Unvollständige Wiederholung');
    return normalized;
  }
  function patchTask(id: string, changes: InternalTaskChanges) {
    validateChanges(changes, taskFields);
    tasks.update(id, (draft) => {
      if (draft.deletedAt !== undefined) throw new Error('Deleted tasks cannot be edited');
      if (account) stampChanges(draft, Object.keys(changes), account.deviceId);
      else draft.version++;
      Object.assign(draft, changes);
      draft.updatedAt = Date.now();
    });
    const task = tasks.get(id)!;
    enqueue(task, 'task', task.deletedAt === undefined ? 'update' : 'delete');
  }
  function initialTaskVersions(task: Task) {
    if (!account) return;
    task.fieldVersions = initialVersions(taskFields, account.deviceId);
    for (const field of taskFields)
      if ((task as unknown as Record<string, unknown>)[field] != null)
        task.fieldVersions[field] = { counter: 1, deviceId: account.deviceId };
  }
  function insertSuccessor(source: Task, id: string, nextDate: string) {
    if (tasks.get(id)) return;
    const plan = planPlacement([...tasks.values()], id, null);
    for (const [key, rank] of plan)
      if (key !== id && tasks.get(key)?.rank !== rank) patchTask(key, { rank });
    const now = Date.now();
    const successor: Task = {
      id,
      title: source.title,
      description: source.description ?? null,
      completed: false,
      dueDate: shiftCalendarDate(source.dueDate, source.recurrenceDate!, nextDate) ?? null,
      plannedDate: shiftCalendarDate(source.plannedDate, source.recurrenceDate!, nextDate) ?? null,
      recurrenceRule: source.recurrenceRule!,
      recurrenceDate: nextDate,
      seriesId: source.seriesId!,
      listId: source.listId ?? null,
      rank: plan.get(id)!,
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...(account ? { ownerId: account.ownerId, remoteRevision: 0 } : {}),
    };
    initialTaskVersions(successor);
    tasks.insert(successor);
    enqueue(successor, 'task', 'create');
  }
  function patchList(id: string, changes: ListChanges) {
    validateChanges(changes, listFields);
    lists.update(id, (draft) => {
      if (draft.deletedAt !== undefined) throw new Error('Deleted lists cannot be edited');
      if (account) stampChanges(draft, Object.keys(changes), account.deviceId);
      else draft.version++;
      Object.assign(draft, changes);
    });
    const list = lists.get(id)!;
    enqueue(list, 'list', list.deletedAt === undefined ? 'update' : 'delete');
  }
  function place(kind: 'task' | 'list', id: string, beforeId: string | null) {
    const collection = kind === 'task' ? tasks : lists;
    const entity = collection.get(id);
    if (!entity || entity.deletedAt !== undefined) throw new Error('Move source no longer exists');
    const plan = planPlacement([...collection.values()], id, beforeId);
    for (const [key, rank] of plan)
      if (collection.get(key)?.rank !== rank) {
        if (kind === 'task') patchTask(key, { rank });
        else patchList(key, { rank });
      }
  }
  async function write(mutate: () => void) {
    await ready;
    await transact(mutate);
    account?.onLocalWrite?.();
  }
  return {
    db,
    adapter,
    syncIdentity: account ? { ownerId: account.ownerId, deviceId: account.deviceId } : undefined,
    tasks,
    lists,
    outbox,
    ready,
    transact,
    async createTask(
      title: string,
      options: CreateTaskOptions = {},
      beforeId: string | null = null,
    ) {
      await ready;
      const normalized = normalizeRecurrence(undefined, options);
      validateChanges({ title, ...normalized }, taskFields);
      const id = crypto.randomUUID();
      await write(() => {
        const plan = planPlacement([...tasks.values()], id, beforeId);
        for (const [key, rank] of plan)
          if (key !== id && tasks.get(key)?.rank !== rank) patchTask(key, { rank });
        const task: Task = {
          id,
          title: title.trim(),
          description: null,
          completed: false,
          dueDate: null,
          plannedDate: null,
          recurrenceRule: null,
          recurrenceDate: null,
          seriesId: null,
          listId: null,
          ...normalized,
          rank: plan.get(id)!,
          version: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          ...(account
            ? {
                ownerId: account.ownerId,
                remoteRevision: 0,
              }
            : {}),
        };
        initialTaskVersions(task);
        tasks.insert(task);
        enqueue(task, 'task', 'create');
      });
      return id;
    },
    async changeTask(id: string, changes: TaskChanges) {
      await ready;
      const source = tasks.get(id);
      if (!source) throw new Error('Task no longer exists');
      const normalized = normalizeRecurrence(source, changes);
      validateChanges(normalized, taskFields);
      const future = { ...source, ...normalized };
      const createsSuccessor =
        !source.completed &&
        future.completed === true &&
        typeof future.recurrenceRule === 'string' &&
        typeof future.recurrenceDate === 'string' &&
        typeof future.seriesId === 'string';
      const nextDate = createsSuccessor
        ? nextOccurrenceDate(future.recurrenceRule!, future.recurrenceDate!)
        : null;
      const nextId = nextDate ? await occurrenceId(future.seriesId!, nextDate) : null;
      await write(() => {
        patchTask(id, normalized);
        if (nextDate && nextId) insertSuccessor(future, nextId, nextDate);
      });
    },
    async createList(name: string) {
      await ready;
      validateChanges({ name }, listFields);
      const id = crypto.randomUUID();
      await write(() => {
        const plan = planPlacement([...lists.values()], id, null);
        for (const [key, rank] of plan)
          if (key !== id && lists.get(key)?.rank !== rank) patchList(key, { rank });
        const list: TaskList = {
          id,
          name: name.trim(),
          rank: plan.get(id)!,
          version: 1,
          ...(account
            ? {
                ownerId: account.ownerId,
                remoteRevision: 0,
                fieldVersions: {
                  ...initialVersions(listFields, account.deviceId),
                  rank: { counter: 1, deviceId: account.deviceId },
                },
              }
            : {}),
        };
        lists.insert(list);
        enqueue(list, 'list', 'create');
      });
      return id;
    },
    async changeList(id: string, changes: ListChanges) {
      await write(() => patchList(id, changes));
    },
    async deleteList(id: string, options: DeleteListOptions = {}) {
      await write(() => {
        if (!lists.get(id) || lists.get(id)?.deletedAt !== undefined)
          throw new Error('List no longer exists');
        patchList(id, { deletedAt: Date.now() });
        for (const task of tasks.values())
          if (task.deletedAt === undefined && task.listId === id)
            patchTask(task.id, options.deleteTasks ? { deletedAt: Date.now() } : { listId: null });
      });
    },
    async moveTask(id: string, beforeId: string | null) {
      await write(() => place('task', id, beforeId));
    },
    async moveList(id: string, beforeId: string | null) {
      await write(() => place('list', id, beforeId));
    },
    async rebalance(kind: 'task' | 'list') {
      await write(() => {
        const rows = [...(kind === 'task' ? tasks.values() : lists.values())]
          .filter((row) => row.deletedAt === undefined)
          .sort(compareRank);
        const ranks = balanced(rows.length);
        rows.forEach((row, index) => {
          if (row.rank !== ranks[index]) {
            if (kind === 'task') patchTask(row.id, { rank: ranks[index] });
            else patchList(row.id, { rank: ranks[index] });
          }
        });
      });
    },
    async close() {
      await Promise.all([tasks.cleanup(), lists.cleanup(), outbox.cleanup()]);
      db.close();
    },
  };
}
