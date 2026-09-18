<script lang="ts">
  import { Hash, Repeat2 } from '@lucide/svelte';
  import { Collapsible, Popover } from 'bits-ui';
  import type { TaskChanges } from '$lib/domain/commands';
  import type { Task, TaskList } from '$lib/domain/models';
  import RecurrenceEditor from './RecurrenceEditor.svelte';
  import TaskDatePicker from './TaskDatePicker.svelte';
  let {
    task,
    lists,
    expanded,
    showList = true,
    save,
    busy,
    close,
  }: {
    busy: boolean;
    close: () => void;
    task: Task;
    lists: TaskList[];
    expanded: boolean;
    showList?: boolean;
    save: (changes: TaskChanges) => Promise<boolean>;
  } = $props();

  let recurrenceOpen = $state(false);
  let wasExpanded = $state<boolean | undefined>(undefined);

  $effect(() => {
    if (wasExpanded === true && !expanded) recurrenceOpen = false;
    wasExpanded = expanded;
  });

  function changePlannedDate(plannedDate: string | null) {
    const recurrenceChanges =
      task.recurrenceRule && !task.dueDate
        ? plannedDate
          ? { recurrenceDate: plannedDate }
          : { recurrenceRule: null }
        : {};
    void save({ plannedDate, ...recurrenceChanges });
  }

  function changeDueDate(dueDate: string | null) {
    const nextAnchor = dueDate ?? task.plannedDate ?? null;
    const recurrenceChanges = task.recurrenceRule
      ? nextAnchor
        ? { recurrenceDate: nextAnchor }
        : { recurrenceRule: null }
      : {};
    void save({ dueDate, ...recurrenceChanges });
  }
</script>

<div
  class={`flex flex-wrap items-center gap-x-1.5 gap-y-0.5 ${expanded ? 'mt-0.5 mr-0 mb-0 -ml-1' : 'm-0 -ml-1'}`}
>
  {#if task.plannedDate}<TaskDatePicker
      kind="planned"
      label="Geplant am bearbeiten"
      value={task.plannedDate}
      compact={!expanded}
      onchange={changePlannedDate}
    />
  {/if}
  {#if task.dueDate}<TaskDatePicker
      kind="due"
      label="Fällig am bearbeiten"
      value={task.dueDate}
      compact={!expanded}
      onchange={changeDueDate}
    />
  {/if}
  {#if expanded && !task.plannedDate}<TaskDatePicker
      kind="planned"
      label="Geplant am bearbeiten"
      value={task.plannedDate}
      compact={!expanded}
      onchange={changePlannedDate}
    />
  {/if}
  {#if expanded && !task.dueDate}<TaskDatePicker
      kind="due"
      label="Fällig am bearbeiten"
      value={task.dueDate}
      compact={!expanded}
      onchange={changeDueDate}
    />
  {/if}
  {#if expanded || task.recurrenceRule}
    <Popover.Root bind:open={recurrenceOpen}>
      <Popover.Trigger
        type="button"
        class={`relative inline-flex min-h-6 cursor-pointer items-center justify-center gap-1.25 rounded-md border-0 bg-transparent px-1 py-0.5 text-[11px] leading-5 whitespace-nowrap text-muted hover:bg-selected disabled:cursor-default disabled:opacity-40 max-mobile:after:absolute max-mobile:after:inset-x-0 max-mobile:after:-inset-y-2.5 max-mobile:after:content-[''] ${task.recurrenceRule ? 'text-accent' : ''}`}
        aria-label={task.recurrenceRule ? 'Wiederholung bearbeiten' : 'Wiederholung hinzufügen'}
        title={task.recurrenceRule ? 'Wiederholung bearbeiten' : 'Wiederholung hinzufügen'}
        disabled={busy}
      >
        <Repeat2 size={15} aria-hidden="true" />
        <span>{task.recurrenceRule ? 'Wiederholt sich' : 'Wiederholen'}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          class="z-10000 max-h-(--bits-popover-content-available-height) w-[min(380px,calc(100vw-24px))] overflow-y-auto rounded-xl border border-border bg-surface p-3 text-[13px] text-text shadow-[0_12px_36px_#28332224,0_2px_6px_#2833220c]"
          data-testid="recurrence-popover"
          aria-label="Wiederholung"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          interactOutsideBehavior={busy ? 'ignore' : 'close'}
          escapeKeydownBehavior={busy ? 'ignore' : 'close'}
        >
          <RecurrenceEditor
            recurrenceRule={task.recurrenceRule}
            recurrenceDate={task.recurrenceDate}
            startDate={task.dueDate ?? task.plannedDate}
            disabled={busy}
            {save}
            close={() => {
              recurrenceOpen = false;
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  {/if}
  {#if !expanded && task.listId && showList}
    <span
      class="inline-flex max-w-[110px] items-center gap-1 truncate px-0 py-0.5 text-[11px] leading-5 text-muted"
      data-testid="task-list-label"
      ><Hash size={12} aria-hidden="true" />{lists.find((list) => list.id === task.listId)?.name ??
        'Liste nicht verfügbar'}</span
    >
  {/if}
</div>
<Collapsible.Content>
  <div
    class={`relative mt-1 flex flex-nowrap items-center gap-2 border-t-0 pt-2 before:absolute before:top-0 before:-right-2 before:border-t before:border-border before:content-[''] max-mobile:gap-1 ${expanded ? 'before:left-[-41px] max-mobile:before:-left-11' : 'before:left-[-33px] max-mobile:before:-left-9'}`}
    data-testid="task-editor-footer"
  >
    <label class="flex min-w-0 flex-1 items-center gap-0.5 text-muted" title="Liste"
      ><Hash size={14} aria-hidden="true" /><select
        class="w-full max-w-45 min-w-0 rounded-md border-0 bg-transparent px-0.5 py-1.25 text-xs text-ellipsis text-text"
        aria-label="Liste bearbeiten"
        value={task.listId ?? ''}
        onchange={(event) => {
          const value = event.currentTarget.value || null;
          if (value !== (task.listId ?? null)) void save({ listId: value });
        }}
      >
        <option value="">Ohne Liste</option>{#each lists as list (list.id)}<option value={list.id}
            >{list.name}</option
          >{/each}
      </select></label
    >
    <div class="flex flex-none gap-1.5 max-mobile:gap-1" data-testid="task-footer-actions">
      <button
        class="min-h-9 cursor-pointer rounded-md border border-transparent bg-transparent px-2.5 py-1.75 text-xs whitespace-nowrap text-danger hover:bg-danger-soft disabled:cursor-default disabled:opacity-40 max-mobile:min-h-10 max-mobile:p-2"
        disabled={busy}
        onclick={() => void save({ deletedAt: Date.now() })}>Löschen</button
      >
      <button
        class="min-h-9 cursor-pointer rounded-md border border-transparent bg-selected px-2.5 py-1.75 text-xs whitespace-nowrap text-accent disabled:cursor-default disabled:opacity-40 max-mobile:min-h-10 max-mobile:p-2"
        aria-label="Details schließen"
        onclick={close}>Schließen</button
      >
    </div>
  </div>
</Collapsible.Content>
