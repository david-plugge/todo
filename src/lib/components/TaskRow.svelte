<script lang="ts">
  import { tick } from 'svelte';
  import { Collapsible } from 'bits-ui';
  import type { Task, TaskList } from '$lib/domain/models';
  import type { TaskChanges } from '$lib/domain/commands';
  import TaskEditor from './TaskEditor.svelte';
  import InlineTaskTitle from './InlineTaskTitle.svelte';
  let {
    task,
    lists: orderedLists,
    day,
    change,
    showList = true,
    editing = $bindable(false),
  }: {
    showList?: boolean;
    editing?: boolean;
    task: Task;
    lists: TaskList[];
    day: string;
    change: (changes: TaskChanges) => Promise<boolean>;
  } = $props();
  let message = $state(''),
    pending = $state(0);
  let failedChanges = $state<TaskChanges | null>(null);
  let editTrigger = $state<HTMLButtonElement | null>(null);
  function collapseOnDrag(node: HTMLElement) {
    const row = node.parentElement!;
    const collapse = () => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && node.contains(active)) active.blur();
      editing = false;
    };
    const open = (event: MouseEvent) => {
      if (editing || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('input, button, select, textarea, a, [role="button"]')
      )
        return;
      editing = true;
    };
    node.addEventListener('click', open);
    row.addEventListener('task-drag-start', collapse);
    return {
      destroy: () => {
        row.removeEventListener('task-drag-start', collapse);
        node.removeEventListener('click', open);
      },
    };
  }
  async function commit(changes: TaskChanges) {
    pending++;
    message = '';
    failedChanges = null;
    try {
      const success = await change(changes);
      if (!success) {
        message = 'Nicht gespeichert · bitte erneut versuchen';
        failedChanges = changes;
      }
      return success;
    } catch {
      failedChanges = changes;
      message = 'Nicht gespeichert · bitte erneut versuchen';
      return false;
    } finally {
      pending--;
    }
  }
  async function closeDetails() {
    editing = false;
    await tick();
    editTrigger?.focus({ preventScroll: true });
  }
</script>

<Collapsible.Root bind:open={editing}>
  {#snippet child({ props })}
    <article
      {...props}
      use:collapseOnDrag
      data-sort-id={task.id}
      data-testid="account-task"
      data-expanded={editing}
      aria-busy={pending > 0}
      class="group/task border border-transparent bg-canvas"
      data-overdue={!task.completed && !!task.dueDate && task.dueDate < day}
      class:rounded-lg={editing}
      class:border-border={editing}
      class:bg-surface={editing}
    >
      <div class="flex min-h-12 items-start gap-3 pl-2.5">
        <label
          class="relative shrink-0 max-mobile:mr-[-22px] max-mobile:flex max-mobile:size-11 max-mobile:items-center"
        >
          <span class="sr-only"
            >{task.completed ? `${task.title} wieder öffnen` : `${task.title} erledigen`}</span
          >
          <input
            class="relative mt-[13px] size-[19px] shrink-0 cursor-pointer appearance-none rounded-full border-[1.5px] border-[#8a9282] bg-transparent p-0 checked:border-accent checked:bg-accent checked:after:absolute checked:after:top-0.5 checked:after:left-1.25 checked:after:h-2.25 checked:after:w-1.25 checked:after:rotate-45 checked:after:border-r-[1.5px] checked:after:border-b-[1.5px] checked:after:border-white checked:after:content-[''] hover:border-accent hover:bg-selected max-mobile:m-0 max-mobile:size-[22px] max-mobile:checked:after:top-0.75 max-mobile:checked:after:left-1.5"
            type="checkbox"
            aria-label={task.completed ? `${task.title} wieder öffnen` : `${task.title} erledigen`}
            checked={task.completed}
            onchange={(event) => void commit({ completed: event.currentTarget.checked })}
          />
        </label>
        <div
          class={`min-w-0 flex-1 self-stretch py-2.5 pr-2 text-left ${editing ? '' : 'flex flex-col gap-0.5'}`}
        >
          {#if editing}
            <div class="min-h-[23px] min-w-0">
              <InlineTaskTitle
                value={task.title}
                save={(title) => commit({ title })}
                invalid={() => {
                  failedChanges = null;
                  message = 'Bitte einen Titel eingeben.';
                }}
              />
            </div>
          {:else}
            <Collapsible.Trigger
              bind:ref={editTrigger}
              class="block min-h-[23px] w-full min-w-0 rounded-none border-0 bg-transparent p-0 text-left text-sm leading-[1.6] text-inherit hover:bg-transparent"
              aria-label={`${task.title} bearbeiten`}
            >
              <span
                class={`block text-sm leading-[1.6] font-normal wrap-anywhere ${task.completed ? 'text-muted line-through' : ''}`}
                data-testid="task-title">{task.title}</span
              >
            </Collapsible.Trigger>
          {/if}
          <TaskEditor
            {task}
            {showList}
            lists={orderedLists}
            expanded={editing}
            busy={pending > 0}
            close={closeDetails}
            save={commit}
          />
          {#if message}
            <div class="mt-3 text-xs text-danger" role="alert" data-testid="field-save-status">
              {message}
              {#if failedChanges}
                <button
                  class="ml-2 min-h-9 cursor-pointer rounded-md border border-border bg-surface px-3 py-2 text-xs text-accent disabled:cursor-default disabled:opacity-40"
                  disabled={pending > 0}
                  onclick={() => {
                    if (failedChanges) void commit(failedChanges);
                  }}>Erneut versuchen</button
                >
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </article>
  {/snippet}
</Collapsible.Root>
