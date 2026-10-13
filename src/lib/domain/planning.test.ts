import { describe, expect, it } from 'vitest';
import type { Task } from './models';
import { belongsToMyDay, isPlannedAhead, isPlannedAfterDeadline, needsPlanning } from './planning';

const day = '2026-09-17';
function task(changes: Partial<Task> = {}): Task {
  return {
    id: 'task',
    title: 'Aufgabe',
    completed: false,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    ...changes,
  };
}

describe('planning views', () => {
  it.each([
    [undefined, undefined, true],
    [null, null, true],
    ['2026-09-18', null, true],
    [null, '2026-09-19', true],
    ['2026-09-18', '2026-09-19', false],
  ] as const)('requires both dates (%s, %s)', (plannedDate, dueDate, expected) => {
    expect(needsPlanning(task({ plannedDate, dueDate }))).toBe(expected);
    expect(needsPlanning(task({ plannedDate, dueDate, listId: 'project' }))).toBe(expected);
  });

  it.each([
    ['2026-09-16', '2026-09-20', true, false],
    [day, '2026-09-20', true, false],
    ['2026-09-18', '2026-09-20', false, true],
    [null, day, true, false],
    [null, '2026-09-16', true, false],
    ['2026-09-18', '2026-09-16', true, true],
    ['2026-09-18', null, false, false],
    [null, '2026-09-20', false, false],
    [null, null, false, false],
  ] as const)('classifies dates (%s, %s)', (plannedDate, dueDate, myDay, plannedAhead) => {
    const entry = task({ plannedDate, dueDate });
    expect(belongsToMyDay(entry, day)).toBe(myDay);
    expect(isPlannedAhead(entry, day)).toBe(plannedAhead);
  });

  it.each([{ completed: true }, { deletedAt: 1 }])('excludes inactive tasks %o', (changes) => {
    expect(needsPlanning(task(changes))).toBe(false);
    expect(belongsToMyDay(task({ plannedDate: day, dueDate: day, ...changes }), day)).toBe(false);
    expect(
      isPlannedAhead(task({ plannedDate: '2026-09-18', dueDate: '2026-09-20', ...changes }), day),
    ).toBe(false);
  });

  it('brings a future task into focus when its planned day arrives', () => {
    const entry = task({ plannedDate: '2026-09-18', dueDate: '2026-09-20' });
    expect(isPlannedAhead(entry, day)).toBe(true);
    expect(belongsToMyDay(entry, day)).toBe(false);
    expect(isPlannedAhead(entry, '2026-09-18')).toBe(false);
    expect(belongsToMyDay(entry, '2026-09-18')).toBe(true);
  });
});

it('warns only when planning is after the deadline', () => {
  expect(isPlannedAfterDeadline({ plannedDate: day, dueDate: '2026-09-16' })).toBe(true);
  expect(isPlannedAfterDeadline({ plannedDate: day, dueDate: day })).toBe(false);
  expect(isPlannedAfterDeadline({ plannedDate: day, dueDate: '2026-09-18' })).toBe(false);
  expect(isPlannedAfterDeadline({ plannedDate: day, dueDate: null })).toBe(false);
  expect(isPlannedAfterDeadline({ plannedDate: null, dueDate: day })).toBe(false);
});
