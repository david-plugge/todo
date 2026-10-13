import type { Task } from './models';

type PlanningDates = Pick<Task, 'plannedDate' | 'dueDate'>;

export function needsPlanning(task: Task): boolean {
  return isOpen(task) && (!task.plannedDate || !task.dueDate);
}

export function belongsToMyDay(task: Task, day: string): boolean {
  return (
    isOpen(task) &&
    ((!!task.plannedDate && task.plannedDate <= day) || (!!task.dueDate && task.dueDate <= day))
  );
}

export function isPlannedAhead(task: Task, day: string): boolean {
  return isOpen(task) && !!task.dueDate && !!task.plannedDate && task.plannedDate > day;
}

export function isPlannedAfterDeadline(task: PlanningDates): boolean {
  return !!task.plannedDate && !!task.dueDate && task.plannedDate > task.dueDate;
}

function isOpen(task: Task): boolean {
  return !task.completed && task.deletedAt === undefined;
}
