import type { Task, TaskList } from './models';

/** Only editable fields cross the command boundary; identity and sync metadata stay internal. */
export type TaskChanges = Partial<
  Pick<
    Task,
    | 'title'
    | 'description'
    | 'completed'
    | 'deletedAt'
    | 'dueDate'
    | 'plannedDate'
    | 'recurrenceRule'
    | 'recurrenceDate'
    | 'listId'
    | 'rank'
  >
>;
export type ListChanges = Partial<Pick<TaskList, 'name' | 'deletedAt' | 'rank'>>;
export type CreateTaskOptions = Pick<
  TaskChanges,
  'description' | 'dueDate' | 'plannedDate' | 'recurrenceRule' | 'recurrenceDate' | 'listId'
>;
export interface DeleteListOptions {
  /** Tombstone active tasks assigned to the list instead of leaving them unassigned. */
  deleteTasks?: boolean;
}

export interface TodoCommands {
  createTask(title: string, options?: CreateTaskOptions, beforeId?: string | null): Promise<string>;
  changeTask(id: string, changes: TaskChanges): Promise<void>;
  createList(name: string): Promise<string>;
  changeList(id: string, changes: ListChanges): Promise<void>;
  /** Deletes the list and either unassigns its tasks or tombstones them. */
  deleteList(id: string, options?: DeleteListOptions): Promise<void>;
  moveTask(id: string, beforeId: string | null): Promise<void>;
  moveList(id: string, beforeId: string | null): Promise<void>;
  rebalance(kind: 'task' | 'list'): Promise<void>;
}
